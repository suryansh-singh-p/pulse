# Credentials are NOT set here. The provider uses the standard AWS credential chain,
# e.g. `$env:AWS_PROFILE = "pulse-admin"` in your terminal.
provider "aws" {
  region = var.region

  # Added to every resource that supports tags.
  default_tags {
    tags = {
      project = "pulse"
      env     = var.env
      owner   = var.owner
    }
  }
}
