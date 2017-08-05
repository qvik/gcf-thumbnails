"use strict";

const fs = require('fs');
const path = require('path');
const gcs = require('@google-cloud/storage')();
const im = require('imagemagick');
const uuidv4 = require('uuid/v4');

// 'Pixel budget' denotes the maximum amount of pixels in the thumbnail
const PIXEL_BUDGET = 50 * 50;

// Our output bucket
const OUTPUT_BUCKET = 'qvik-gcf-thumbnails-output';

/**
 * Uploads a local file into a GCS bucket.
 *
 * @param srcFilePath
 * @param dstFilePath
 * @param contentType
 * @returns {Promise}
 */
function uploadFile(srcFilePath, dstFilePath, contentType) {
  console.log('uploading file to', dstFilePath);

  return new Promise((resolve, reject) => {
    // Write the file to the output bucket
    const bucket = gcs.bucket(OUTPUT_BUCKET);

    const uploadOptions = {
      destination: dstFilePath,
      metadata: {contentType: contentType}
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
function downscaleImage(imageFilePath, width, height) {
  console.log('Downscaling image: ', imageFilePath);

  return new Promise((resolve, reject) => {
    // Calculate the size of the thumbnail
    const origPixels = width * height;
    const ratio = Math.sqrt(PIXEL_BUDGET / origPixels);
    console.log('pixel ratio', ratio);
    const thumbWidth = Math.round(ratio * width);
    const thumbHeight = Math.round(ratio * height);
    console.log('thumb size', thumbWidth, thumbHeight);

    im.resize({
      srcPath: imageFilePath,
      dstPath: imageFilePath,
      quality: 0.3,
      format: 'jpg',
      width: thumbWidth,
      height: thumbHeight
    }, (err) => {
      if (err) {
        return reject(err);
      }

      resolve({thumbWidth: thumbWidth, thumbHeight: thumbHeight});
    });
  });
}

/**
 * Blurs the given image.
 *
 * @param imageFilePath
 * @returns {Promise}
 */
function blurImage(imageFilePath) {
  console.log('blurring image: ', imageFilePath);

  return new Promise((resolve, reject) => {
    im.convert([imageFilePath, '-gaussian-blur', 5, imageFilePath], (err) => {
        if (err) {
          return reject(err);
        }

        console.log('Image blurred OK!');

        resolve();
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

function extractThumbData(imageFilePath, width, height) {
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

      console.log(`sosIndex: ${sosIndex}, eoiIndex: ${eoiIndex}`);

      // JPEG image data is everything between these markers; grab it
      const dataStartIndex = sosIndex + 2;
      const jpegData = buffer.slice(dataStartIndex, eoiIndex);
      console.log(`Got ${jpegData.length} bytes of jpegData`);

      // Create our custom 4-byte header
      const header = new Uint8Array([0x01, 0x01, width, height]);
      console.log(`${header.length} bytes of header constructed.`);

      // Combine the header + JPEG data
      const completeData = new Uint8Array(header.length + jpegData.length);
      completeData.set(header);
      completeData.set(jpegData, header.length);

      console.log('completeData len', completeData.length);
      console.log(`completeData: ${completeData}`);

      resolve(completeData);
    });
  });
}

/**
 * Writes the thumbnail data to the output bucket as a file.
 *
 * @param originalFileName
 * @param thumbData
 * @returns {Promise}
 */
function storeThumbData(originalFileName, thumbData) {
  console.log(`Storing ${thumbData.length} bytes of thumbnail data`);

  return new Promise((resolve, reject) => {
    // Write the thumb data into a local file
    const tempDataFilename = `/tmp/${uuidv4()}`;

    console.log(`thumbData: ${thumbData}`);
    console.log('is it uint8array?', (thumbData instanceof Uint8Array));

    const dataBuffer = Buffer.from(thumbData.buffer);
    console.log(`writing dataBuffer: ${dataBuffer}`);

    fs.writeFile(tempDataFilename, dataBuffer, (err) => {
      if (err) {
        return reject(err);
      }

      console.log('Thumb data written into a file OK!');

      // Upload the thumb data to the output bucket
      uploadFile(tempDataFilename, originalFileName + ".thumbdata")
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
 * @param width
 * @param height
 * @returns {Promise.<TResult>}
 */
function thumbnailize(originalFileName, imageFilePath, width, height) {
  console.log('originalFileName=', originalFileName);

  let thumbWidth = null;
  let thumbHeight = null;

  return downscaleImage(imageFilePath, width, height)
    .then((result) => {
      console.log('at then() after downscaleImage()');

      thumbWidth = result.thumbWidth;
      thumbHeight = result.thumbHeight;

      //TODO remove, this is just debug
      //uploadFile(imageFilePath, originalFileName, 'image/jpeg');

      return blurImage(imageFilePath);
    })
    .then(() => {
      console.log('at then() after blurImage');

      //TODO remove, this is just debug
      //uploadFile(imageFilePath, 'blurred-' + originalFileName, 'image/jpeg');

      return extractThumbData(imageFilePath, thumbWidth, thumbHeight);
    })
    .then((thumbData) => {
      console.log('at then() after extractThumbData()');

      return storeThumbData(originalFileName, thumbData);
    });
};

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
 * Processes the given input file.
 *
 * @param file
 * @returns {Promise}
 */
function processFile(file) {
  console.log('Processing input file:', file.name);

  return new Promise((resolve, reject) => {
    // Form a local path for the file
    const tempLocalFilename = `/tmp/${uuidv4()}`;

    // Download file from bucket.
    file.download({destination: tempLocalFilename})
      .catch((err) => {
        console.error('Failed to download file.', err);
        return reject(err);
      })
      .then(() => {
        console.log(`Image ${file.name} downloaded to ${tempLocalFilename}.`);

        return readImageDimensions(tempLocalFilename);
      })
      .then((dimensions) => {
        console.log('at then() after readImageFeatures()', dimensions);

        return thumbnailize(file.name, tempLocalFilename,
          dimensions.width, dimensions.height);
      })
      .then(() => {
        console.log("All done!");
        resolve();
      });
  });
}

/**
 * Cloud Function for extracting thumbnail data out of incoming images.
 *
 * @param {object} event The Cloud Functions event.
 */
exports.thumbnails = function(event) {
  const object = event.data;

  if (object.resourceState === 'not_exists') {
    console.log(`File ${object.name} deleted.`);
    return Promise.resolve();
  } else if (object.metageneration === '1') {
    // metageneration attribute is updated on metadata changes.
    // on create value is 1
    console.log(`File ${object.name} uploaded.`);
    const file = gcs.bucket(object.bucket).file(object.name);
    //return processFile(file);

    return processFile(file);
  } else {
    console.log(`File ${object.name} metadata updated.`);
    return Promise.resolve();
  }
};
