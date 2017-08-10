# Google Cloud Function for Thumbnailization

This is a Google Cloud Function for creating JPEG thumbnail data out of uploaded images. Any image stored in the input bucket is processed, a thumbnail data (= a downscaled, blurred JPEG with the header removed) is written to the output bucket.

Note that the `exports.foo = ..` part is the function entry point. The exported name must match with the name specified in the `gcloud beta functions deploy` command.

## Set up your environment

```sh
export STAGING_BUCKET=<your-staging-bucket>
export INPUT_BUCKET=<your-input-bucket>
export OUTPUT_BUCKET=<your-output-bucket>
gcloud config set project <project-id>
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

## Reading the function logs

```sh
gcloud beta functions logs read --limit 20
```
