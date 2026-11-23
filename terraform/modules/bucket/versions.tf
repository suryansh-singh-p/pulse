terraform {
  required_providers {
    # The module says WHICH provider it uses; the root module pins the version.
    aws = {
      source = "hashicorp/aws"
    }
  }
}
