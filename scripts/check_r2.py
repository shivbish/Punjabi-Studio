"""Check the Cloudflare R2 settings in .env.   Run:  python scripts/check_r2.py

Writes, reads, lists and deletes one temporary object under your R2_PREFIX
(its name does not end in .json, so it never shows up as a dictionary).
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from storage import Store  # noqa: E402


def main() -> int:
    store = Store.from_env(ROOT / "data", ROOT / "dictionary.json")
    if not store.uses_r2:
        print("R2 is not configured: set R2_ACCOUNT_ID and R2_BUCKET_NAME in .env.")
        return 1

    s3, bucket = store.s3, store.bucket
    key = f"{store.prefix}/.connection-check-{os.getpid()}.txt"
    try:
        print("1. Upload...")
        s3.put_object(Bucket=bucket, Key=key, Body=b"hello r2")
        print("2. Read back...")
        assert s3.get_object(Bucket=bucket, Key=key)["Body"].read() == b"hello r2"
        print("3. Head (used for fast change checks)...")
        s3.head_object(Bucket=bucket, Key=key)
        print("4. List...")
        listed = s3.list_objects_v2(Bucket=bucket, Prefix=f"{store.prefix}/")
        assert any(item["Key"] == key for item in listed.get("Contents", []))
        print("5. Clean up...")
        s3.delete_object(Bucket=bucket, Key=key)
    except Exception as exc:  # noqa: BLE001 - this is a diagnostic script
        print(f"\nFAILED: {exc}")
        return 1

    print(f"\nCloudflare R2 works (bucket {bucket!r}, prefix {store.prefix!r}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
