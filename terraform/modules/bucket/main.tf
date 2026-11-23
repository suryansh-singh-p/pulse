# A private, versioned, encrypted S3 bucket with lifecycle rules.
# Provider settings (region, default tags) are inherited from the caller.

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
  # force_destroy stays false (default): destroy fails on a non-empty bucket.
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # Version rules should only apply once versioning is on.
  depends_on = [aws_s3_bucket_versioning.this]

  rule {
    id     = "raw-tiering-and-expiry"
    status = "Enabled"

    filter {
      prefix = var.tiered_prefix
    }

    transition {
      days          = var.ia_transition_days
      storage_class = "STANDARD_IA"
    }

    # In a versioned bucket this adds a delete marker; the data becomes a
    # noncurrent version, removed by the rule below.
    expiration {
      days = var.expiration_days
    }
  }

  rule {
    id     = "cleanup-noncurrent"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_days
    }

    expiration {
      expired_object_delete_marker = true
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
