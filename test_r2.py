import os
import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv()  # Load the .env file

s3 = boto3.client(
    service_name="s3",
    endpoint_url=f"https://{os.getenv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
    aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"),
    region_name="auto",
)

bucket = os.getenv("R2_BUCKET_NAME")
key = os.getenv("R2_OBJECT_KEY", "dictionary.json")

# 1. Upload test
print("1. Testing upload...")
s3.put_object(Bucket=bucket, Key="test_r2_check.txt", Body=b"hello r2")
print("   Upload successful")

# 2. Read test
print("2. Testing read...")
response = s3.get_object(Bucket=bucket, Key="test_r2_check.txt")
content = response["Body"].read()
print(f"   Read content: {content}")

# 3. Clean up test files
print("3. Cleaning up...")
s3.delete_object(Bucket=bucket, Key="test_r2_check.txt")
print("   Deleted")

print("\n✅ Cloudflare R2 connection is working!")