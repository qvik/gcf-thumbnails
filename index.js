/**
 * This is a Node.js / Cloud Function implementation of
 * 'JPEG preview thumbnails' used nowadays by most quality UI applications
 * on the market.
 *
 * For an idea how this works, please see https://goo.gl/vuf9xG
 *
 * Released under the MIT license:
 *
 * Copyright 2015-2017 QVIK
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const gcs = require('@google-cloud/storage')();
const im = require('imagemagick');
const uuidv4 = require('uuid/v4');
const dc = require('dominant-color');
const config = require('./config');

// 'Pixel budget' denotes the maximum amount of pixels in the thumbnail
const PIXEL_BUDGET = 50 * 50;

/**
 * Extracts image dimensions.
 *
 * @param imageFilePath
 * @returns {Promise}
 */
function readImageDimensions(imageFilePath) {
  return new Promise((resolve, reject) => {
    im.identify(imageFilePath, (err, features) => {
      if (err) {
        return reject(err);
      }

      resolve({width: features.width, height: features.height});
    });
  });
}

/**
 * Extracts the image's dominant color.
 *
 * @param imageFilePath
 * @returns {Promise}
 */
function getDominantColor(imageFilePath) {
  return new Promise((resolve, reject) => {
    dc(imageFilePath, (err, color) => {
      if (err) {
        return reject(err);
      }

      resolve(color);
    });
  });
}

/**
 * Uploads a local file into a GCS bucket.
 *
 * @param srcFilePath Local filesystem path of the file to upload
 * @param dstFilePath Path of the destination file in the bucket
 * @param contentType MIME type of the file
 * @param metadata user-provided metadata in key-value pairs
 * @returns {Promise}
 */
function uploadFile(srcFilePath, dstFilePath, contentType, metadata) {
  return new Promise((resolve, reject) => {
    const bucket = gcs.bucket(config.OUTPUT_BUCKET);
    const uploadOptions = {
      destination: dstFilePath,
      metadata: {
        contentType: contentType,
        metadata: metadata
      }
    };

    bucket.upload(srcFilePath, uploadOptions, (err) => {
      if (err) {
        return reject(err);
      }

      console.log(`File ${dstFilePath} written to output bucket OK!`);

      resolve();
    });
  });
}

/**
 * Resizes the image to a JPEG thumbnail that fits in the 'pixel budget'.
 *
 * @param imageFilePath
 * @param width
 * @param height
 * @returns {Promise}
 */
function convertImage(imageFilePath, width, height) {
  return new Promise((resolve, reject) => {
    // Calculate the size of the thumbnail from the size of the original
    // image and the 'pixel budget'
    const origPixels = width * height;
    const ratio = Math.sqrt(PIXEL_BUDGET / origPixels);
    const thumbWidth = Math.round(ratio * width);
    const thumbHeight = Math.round(ratio * height);

    // Downscale the image to a thumbnail and store it with a lower quality
    // as a JPEG without optimizing the header's Huffman color coding tables
    // to allow for interchangeable header; also strip any comments and such
    // for small binary size.
    const params = [
      imageFilePath,
      '-define', 'jpeg:optimize-coding=false',
      '-compress', 'JPEG',
      '-strip',
      '-quality', 30,
      '-resize', `${thumbWidth}x${thumbHeight}`,
      imageFilePath
    ];

    console.log(`Calling convert with params: ${params.join(' ')}`);

    im.convert(params, (err) => {
      if (err) {
        return reject(err);
      }

      resolve({width: thumbWidth, height: thumbHeight});
    });
  });
}

/**
 * Finds the index of the given JFIF marker byte starting from the given index.
 *
 * @param marker
 * @param startIndex
 * @param data
 * @returns {number}
 */
function findMarker(marker, startIndex, data) {
  let index = startIndex;
  let previousByte = null;

  while (index < data.length) {
    let currentByte = data[index];

    if ((previousByte === 0xFF) && (currentByte === marker)) {
      return index - 1;
    }

    previousByte = currentByte;
    index++;
  }

  return null;
}

/**
 * Locates the JPEG data part in the thumbnailized image, extracts it
 * and glues our custom 4-byte header to it and returns the combined byte
 * array.
 *
 * @param imageFilePath
 * @param dimensions
 * @returns {*}
 */
function extractThumbData(imageFilePath, dimensions) {
  if (!dimensions || !dimensions.width || !dimensions.height) {
    return Promise.reject(new Error("Invalid thumb dimensions"));
  }

  return new Promise((resolve, reject) => {
    // Read the file into a Uint8Array
    fs.readFile(imageFilePath, (err, data) => {
      if (err) {
        return reject(err);
      }

      console.log(`${data.length} bytes of JPEG file data read`);

      // Create a Uint8Array for byte by byte inspection
      const buffer = new Uint8Array(data);

      // Find the Start-of-Scan marker (after which JPEG data starts)
      const sosIndex = findMarker(0xDA, 0, buffer);
      if (sosIndex === null) {
        return reject(new Error('SOS marker not found'));
      }

      // Find the End-of-Image marker (at which JPEG data ends)
      const eoiIndex = findMarker(0xD9, sosIndex, buffer);
      if (eoiIndex === null) {
        return reject(new Error('EOI marker not found'));
      }

      // JPEG image data is everything between these markers; grab it
      const dataStartIndex = sosIndex + 2;
      const jpegData = buffer.slice(dataStartIndex, eoiIndex);

      // Create our custom 4-byte header
      const header = new Uint8Array([0x01, 0x01,
        dimensions.width, dimensions.height]);

      // Combine the header + JPEG data
      const completeData = new Uint8Array(header.length + jpegData.length);
      completeData.set(header);
      completeData.set(jpegData, header.length);

      resolve(completeData);
    });
  });
}

/**
 * Writes the thumbnail data to the output bucket as a file.
 *
 * @param originalFileName
 * @param thumbData
 * @param originalMetadata
 * @param dominantColor
 * @returns {Promise}
 */
function storeThumbData(originalFileName, thumbData, originalMetadata,
                        dominantColor) {
  console.log(`Storing ${thumbData.length} bytes of thumbnail data`);

  return new Promise((resolve, reject) => {
    // Write the thumb data into a local file
    const tempDataFilename = `/tmp/${uuidv4()}`;
    const dataBuffer = Buffer.from(thumbData.buffer);

    fs.writeFile(tempDataFilename, dataBuffer, (err) => {
      if (err) {
        return reject(err);
      }

      // Create our set of metadata
      const metadata = {
        dominantColor: dominantColor
      };

      // Merge in the original file's metadata
      Object.assign(metadata, originalMetadata);

      // Upload the thumb data to the output bucket
      uploadFile(tempDataFilename, originalFileName + ".thumbdata",
        "application/octet-stream", metadata)
        .then(() => {
          resolve();
        })
        .catch((err) => {
          reject(err);
        });
    });
  });
}

/**
 * Creates a thumbnail of the given image.
 *
 * @param originalFileName
 * @param imageFilePath
 * @param dimensions
 * @param originalMetadata
 * @param dominantColor
 * @returns {Promise}
 */
function thumbnailize(originalFileName, imageFilePath,
                      dimensions, originalMetadata, dominantColor) {
  return convertImage(imageFilePath, dimensions.width, dimensions.height)
    .then((result) => {
      // Extract the final thumbnail dimensions, as these will be decided
      // by ImageMagick to retain optimal aspect ratio
      return readImageDimensions(imageFilePath);
    })
    .then((dimensions) => {
      console.log(`Final thumbnail dimensions are: ${dimensions}`);

      return extractThumbData(imageFilePath, dimensions);
    })
    .then((thumbData) => {
      return storeThumbData(originalFileName, thumbData, originalMetadata,
        dominantColor);
    });
};

/**
 * Processes the given input file.
 *
 * @param file
 * @returns {Promise}
 */
function processFile(file) {
  console.log(`Processing file '${file.name}..`);

  return new Promise((resolve, reject) => {
    // Form a local path for the file
    const tempLocalFilename = `/tmp/${uuidv4()}`;
    let originalMetadata = null;
    let dominantColor = null;

    // Download file from bucket.
    file.download({destination: tempLocalFilename})
      .then(() => {
        return getDominantColor(tempLocalFilename);
      })
      .then((color) => {
        dominantColor = color;
        return file.getMetadata();
      })
      .then((data) => {
        originalMetadata = data[0].metadata || {};
        console.log(`Got original file metadata: ${originalMetadata}`);

        return readImageDimensions(tempLocalFilename);
      })
      .then((dimensions) => {
        return thumbnailize(file.name, tempLocalFilename,
          dimensions, originalMetadata, dominantColor);
      })
      .then(() => {
        console.log("All done!");
        resolve();
      })
      .catch((err) => {
        console.error('Something went wrong!', err);
        return reject(err);
      })
  });
}

/**
 * Cloud Function for extracting thumbnail data out of incoming images.
 *
 * event.data.metageneration attribute is updated on metadata changes.
 * On create value is 1. A value of > 1 indicates a metadata update.
 *
 * @param {object} event The Cloud Functions event.
 */
exports.thumbnails = function(event) {
  const object = event.data;

  if (object.resourceState === 'not_exists') {
    console.log(`File ${object.name} deleted.`);
    return Promise.resolve();
  } else if (object.metageneration === '1') {
    console.log(`File ${object.name} uploaded.`);
    const file = gcs.bucket(object.bucket).file(object.name);

    return processFile(file);
  } else {
    console.log(`File ${object.name} metadata updated.`);
    return Promise.resolve();
  }
};
