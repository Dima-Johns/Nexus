"""Lokal S3 (moto) sinovi uchun yordamchi: python s3check.py init|count|db"""
import sys

import boto3

from common import pg_connect

s3 = boto3.client(
    "s3", endpoint_url="http://127.0.0.1:9000", aws_access_key_id="test", aws_secret_access_key="test", region_name="us-east-1"
)
BUCKET = "nexus-proofs"

cmd = sys.argv[1] if __name__ == "__main__" and len(sys.argv) > 1 else ""
if cmd == "init":
    s3.create_bucket(Bucket=BUCKET)
    print("bucket tayyor")
elif cmd == "count":
    keys = [o["Key"] for p in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET) for o in p.get("Contents", [])]
    print(f"omborda {len(keys)} ta fayl", keys[:3])
elif cmd == "db":
    with pg_connect() as db:
        print(db.execute(
            "select count(*) filter (where storage_key <> ''), count(*) filter (where storage_key = '' and length(data) > 0),"
            " coalesce(sum(length(data)), 0) from proof_photos"
        ).fetchone(), "(omborda, bazada, bazadagi bayt)")
