# Large file uploads — storage setup and failure modes

Files up to 50 MB go through the API as base64 JSON (`POST /api/files`). Larger files, up to
1 GB (`MAX_LARGE_FILE_SIZE_BYTES` in `packages/shared/src/schemas/files.ts`), go **straight from
the browser to object storage** over presigned multipart URLs:

1. `POST /api/files/uploads` — the API creates an S3 multipart upload and returns one presigned
   PUT URL per part (16 MiB parts; larger when the file needs more than 10,000 of them).
2. The browser PUTs each part (3 at a time, 3 attempts each) and reads each part's `ETag` header.
3. `POST /api/files/uploads/:id/complete` — the API stitches the parts, checks the stored size
   against the declared size and creates the `files` row.
4. `DELETE /api/files/uploads/:id` abandons an upload.

Reading a file over 50 MB returns `contentOmitted: true` and a one-hour `downloadUrl` instead of
inline bytes, so the API never buffers it.

## One-time setup per environment

### 1. A browser-reachable storage address

Presigned URLs carry the storage host and are signed for it. If `S3_ENDPOINT` is an address only
the API can resolve (docker-compose uses `http://seaweedfs:8333`), set `S3_PUBLIC_ENDPOINT` to the
address browsers use. With a public service such as Hetzner Object Storage the two are the same
and `S3_PUBLIC_ENDPOINT` can stay unset.

### 2. A CORS rule on the bucket

The browser calls storage directly, so the bucket must allow it, and must **expose the `ETag`
header**: without that the page cannot read the part ETags and the upload cannot be completed
(the uploader fails with "Storage did not return an ETag. Check the bucket CORS rule.").

`cors.json`, with one `AllowedOrigins` entry per frontend origin (prod, staging, local dev):

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.example.com", "http://localhost:5173"],
      "AllowedMethods": ["GET", "HEAD", "PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

```bash
aws s3api put-bucket-cors \
  --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" \
  --cors-configuration file://cors.json
```

### 3. Clean up abandoned uploads

A browser that is closed mid-upload leaves its parts in the bucket, billed but unusable. Add a
lifecycle rule that aborts incomplete multipart uploads after a few days:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 3 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" \
  --lifecycle-configuration file://lifecycle.json
```

Rows in `file_uploads` stay `pending` past their `expires_at` (12 h) when this happens; they are
inert (complete refuses them) and can be deleted.

## Raising the limit

Change `MAX_LARGE_FILE_SIZE_BYTES`. Nothing else is size-bound: `files.size_bytes` is a bigint,
part size grows with the file, and S3 allows 5 TiB per object. Before raising it past a few GB,
check the proxy in front of the API is irrelevant to this path (it is: bytes never touch the API)
and that the browser can hold the upload open for the time it takes on a slow link; parts are
retried individually but there is no resume after a page reload yet.

## Failure modes

| Symptom | Cause |
| --- | --- |
| Upload fails after the last part with "Storage did not return an ETag" | Bucket CORS does not expose `ETag` |
| Parts fail with a CORS error in the console | Frontend origin missing from `AllowedOrigins`, or `PUT` not allowed |
| Parts fail with `SignatureDoesNotMatch` | `S3_PUBLIC_ENDPOINT` differs from the host the browser really calls (a proxy rewriting `Host`) |
| `complete` returns 400 "Uploaded size does not match" | A part was truncated; the object is deleted and the upload must restart |
| `complete` returns 400 "Storage did not accept the uploaded parts" | Wrong or missing ETags; the upload stays open and can be retried |
