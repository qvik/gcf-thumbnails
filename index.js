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

// convert example:
// `convert`, [`-define`, `jpeg:size=600x400`, tempLocalFile, `-thumbnail`,
// `600x400^`, `-gravity`, `center`, `-extent`, `600x400`, tempLocalThumbFileMedium]

// image size:
// convert larvi.jpg -ping -format "%w x %h" info:

function thumbnailize(imageFilePath, width, height) {
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

      console.log('Image resized OK!');

      //TODO next step

      //TODO 1. downscale 2. blur 3. extract JPEG data 4. store to output bucket


      // All done
      resolve();
    });


  });
};

function processFile(file) {
  console.log('Processing input file: ', file.name);
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

          // console.log("Image features: ", features);
          // { format: 'JPEG', width: 3904, height: 2622, depth: 8 }

          return thumbnailize(tempLocalFilename, features.width,
            features.height);
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

  if (object.resourceState === 'not_exists') {
    console.log(`File ${object.name} deleted.`);
    callback();
  } else if (object.metageneration === '1') {
    // metageneration attribute is updated on metadata changes.
    // on create value is 1
    console.log(`File ${object.name} uploaded.`);

    const file = gcs.bucket(object.bucket).file(object.name);

    processFile(file, callback)
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
