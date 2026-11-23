terraform {
  # Fail early with a clear error on an older Terraform.
  required_version = ">= 1.17"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # ~> 6.0 allows any 6.x (fixes and features), never 7.0 (possible breaking changes).
      # The exact version used is pinned in .terraform.lock.hcl.
      version = "~> 6.0"
    }
  }
}
