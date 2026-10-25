{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "KmsUseOnKeychainKeys",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey", "kms:TagResource"],
      "Resource": "arn:aws:kms:eu-central-1:__ACCOUNT_ID__:key/*",
      "Condition": {
        "ForAnyValue:StringLike": {
          "kms:ResourceAliases": "alias/maskin-keychain-__TARGET__-*"
        }
      }
    },
    {
      "Sid": "KmsCreateTaggedKeysInRegion",
      "Effect": "Allow",
      "Action": ["kms:CreateKey", "kms:TagResource"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/maskin-keychain": "__TARGET__",
          "aws:RequestedRegion": "eu-central-1"
        }
      }
    },
    {
      "Sid": "KmsAliasNamesUnderPrefix",
      "Effect": "Allow",
      "Action": "kms:CreateAlias",
      "Resource": "arn:aws:kms:eu-central-1:__ACCOUNT_ID__:alias/maskin-keychain-__TARGET__-*"
    },
    {
      "Sid": "KmsAliasOnTaggedKeysOnly",
      "Effect": "Allow",
      "Action": "kms:CreateAlias",
      "Resource": "arn:aws:kms:eu-central-1:__ACCOUNT_ID__:key/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/maskin-keychain": "__TARGET__"
        }
      }
    },
    {
      "Sid": "WormWrite",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::__WORM_BUCKET__/snapshots/*"
    },
    {
      "Sid": "SnapshotRead",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::__WORM_BUCKET__/snapshots/*"
    },
    {
      "Sid": "ListSameBucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::__WORM_BUCKET__",
      "Condition": {
        "StringLike": {
          "s3:prefix": "snapshots/*"
        }
      }
    },
    {
      "Sid": "NoTaggingOfKeysThatAreNotAlreadyInScope",
      "Effect": "Deny",
      "Action": ["kms:TagResource", "kms:UntagResource"],
      "Resource": "arn:aws:kms:eu-central-1:__ACCOUNT_ID__:key/*",
      "Condition": {
        "StringNotEquals": {
          "aws:ResourceTag/maskin-keychain": "__TARGET__"
        }
      }
    },
    {
      "Sid": "ExplicitDenies",
      "Effect": "Deny",
      "Action": [
        "kms:ScheduleKeyDeletion",
        "kms:DisableKey",
        "kms:PutKeyPolicy",
        "kms:CreateGrant",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:BypassGovernanceRetention",
        "s3:PutObjectRetention",
        "s3:PutObjectLegalHold",
        "s3:PutBucketObjectLockConfiguration",
        "iam:*"
      ],
      "Resource": "*"
    }
  ]
}
