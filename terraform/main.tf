# Reads (never creates) the identity Terraform is running as; used for the account ID.
data "aws_caller_identity" "current" {}

locals {
  # Bucket names are global across all AWS accounts; the account ID makes ours unique.
  bucket_name = "${var.bucket_prefix}-${var.env}-${data.aws_caller_identity.current.account_id}"
}

module "events_bucket" {
  source = "./modules/bucket"

  bucket_name = local.bucket_name
  # Lifecycle inputs use the module defaults (raw/, 30 -> IA, 90 expiry, 30 noncurrent).
}

# The resources used to live in this file. These blocks tell Terraform they were
# moved into the module, so state is updated instead of destroying and recreating.
moved {
  from = aws_s3_bucket.events
  to   = module.events_bucket.aws_s3_bucket.this
}

moved {
  from = aws_s3_bucket_versioning.events
  to   = module.events_bucket.aws_s3_bucket_versioning.this
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.events
  to   = module.events_bucket.aws_s3_bucket_server_side_encryption_configuration.this
}

moved {
  from = aws_s3_bucket_public_access_block.events
  to   = module.events_bucket.aws_s3_bucket_public_access_block.this
}

moved {
  from = aws_s3_bucket_lifecycle_configuration.events
  to   = module.events_bucket.aws_s3_bucket_lifecycle_configuration.this
}
