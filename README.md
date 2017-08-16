# Google Cloud Function for Thumbnailization

This is a Google Cloud Function for creating JPEG thumbnail data out of uploaded images. Any image stored in the input bucket is processed, a thumbnail data (= a downscaled, blurred JPEG with the header removed) is written to the output bucket.

Note that the `exports.foo = ..` part is the function entry point. The exported name must match with the name specified in the `gcloud beta functions deploy` command.

## Set up your environment

```sh
export STAGING_BUCKET=<your-staging-bucket>
export INPUT_BUCKET=<your-input-bucket>
gcloud config set project <project-id>
```

## config.js

You must create a file in the main directory with the name `config.js` with the following contents:

```sh
exports.OUTPUT_BUCKET = '<your-output-gcs-bucket>';
```

## Create your buckets

Obviously you only do this once:

```sh
gsutil mb -c regional -l europe-west1 gs://$INPUT_BUCKET
gsutil mb -c regional -l europe-west1 gs://$OUTPUT_BUCKET
gsutil mb -c regional -l europe-west1 gs://$STAGING_BUCKET
```

## Deploy the Cloud Function

```sh
gcloud beta functions deploy thumbnails --stage-bucket $STAGING_BUCKET --trigger-bucket $INPUT_BUCKET
```

## Upload an image

```sh
gsutil cp <some-local-image-path> gs://$INPUT_BUCKET
```

## Read the function logs

```sh
gcloud beta functions logs read --limit 20
```

## Reassembly

To reassemble the images, use the JPEG header `IM_JPEG_header.bin` found in the root directory of this project.

This file has been generated by running the following and extracting the header part:

```sh
convert <input> -define jpeg:optimize-coding=false -compress JPEG -strip -quality 30 <output>
```

So it is important that any JPEG thumbnail data get generated by the Node.js code using the same settings to match the header properly.
