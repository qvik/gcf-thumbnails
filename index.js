"use strict";

//const exec = require('child_process').exec;
const fs = require('fs');
const path = require('path');
const gcs = require('@google-cloud/storage')();
const im = require('imagemagick');
const uuidv4 = require('uuid/v4');

// const vision = require('@google-cloud/vision')();

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
    // const thumbFilePath = path.join(path.dirname(filePath), thumbFileName);

    const uploadOptions = {
      destination: dstFilePath,
      metadata: {contentType: contentType}
    };

    bucket.upload(srcFilePath, uploadOptions, (err) => {
      if (err) {
        return reject(err);
      }

      console.log('File written to output bucket OK!');

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

      resolve();
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
    //convert ${tempLocalFilename} -channel RGBA -blur 0x24 ${tempLocalFilename}
    im.convert([imageFilePath, '-gaussian-blur', 5, imageFilePath], (err) => {
        if (err) {
          return reject(err);
        }

        console.log('Image blurred OK!');

        resolve();
      });
  });
}

// convert example:
// `convert`, [`-define`, `jpeg:size=600x400`, tempLocalFile, `-thumbnail`,
// `600x400^`, `-gravity`, `center`, `-extent`, `600x400`, tempLocalThumbFileMedium]

// image size:
// convert larvi.jpg -ping -format "%w x %h" info:

function thumbnailize(originalFileName, imageFilePath, width, height) {
  console.log('originalFileName=', originalFileName);

  return downscaleImage(imageFilePath, width, height)
    .then(() => {
      console.log('at then() after downscaleImage()');

      //TODO remove, this is just debug
      uploadFile(imageFilePath, originalFileName, 'image/jpeg');

      return blurImage(imageFilePath);
    })
    .then(() => {
      console.log('at then() after blurImage');

      //TODO remove, this is just debug
      return uploadFile(imageFilePath, 'blurred-' + originalFileName, 'image/jpeg');
    });
};

function processFile(file) {
  console.log('Processing input file:', file.name);
// const tempLocalFilename = `/tmp/${path.parse(file.name).base}`;

  return new Promise((resolve, reject) => {
    // Form a local path for the file
    const tempLocalFilename = `/tmp/${uuidv4()}`;
    console.log('tempLocalFilename=', tempLocalFilename);

    // Download file from bucket.
    file.download({destination: tempLocalFilename})
      .catch((err) => {
        console.error('Failed to download file.', err);
        return reject(err);
      })
      .then(() => {
        console.log(`Image ${file.name} downloaded to ${tempLocalFilename}.`);

        // Figure out the image dimensions
        im.identify(tempLocalFilename, (err, features) => {
          if (err) {
            return reject(err);
          }

          thumbnailize(file.name, tempLocalFilename, features.width,
            features.height)
            .then(() => {
              console.log('thumbnailize() OK!');
              resolve();
            })
            .catch((err) => {
              console.log('thumbnailize() failed', err);
              reject(err);
            })
        });
      });
  });
}

/**
 * TODO
 *
 * @param {object} event The Cloud Functions event.
 * @param {function} callback The callback function.
 */
exports.thumbnails = function (event, callback) {
  const object = event.data;
  console.log('object', object);

  if (object.resourceState === 'not_exists') {
    console.log(`File ${object.name} deleted.`);
    callback();
  } else if (object.metageneration === '1') {
    // metageneration attribute is updated on metadata changes.
    // on create value is 1
    console.log(`File ${object.name} uploaded.`);

    const file = gcs.bucket(object.bucket).file(object.name);

    processFile(file)
      .then(() => {
        console.log('processFile() completed.');
        callback();
      })
      .catch((err) => {
        console.log('processFile() failed: ', err);
        callback();
      });
  } else {
    console.log(`File ${object.name} metadata updated.`);
    callback();
  }
};
