# Security

The CLI lists object metadata using local credentials. It does not send telemetry, read payloads, or mutate cloud objects. The selected AWS credential chain may contact AWS identity services before listing. R2 uses the explicitly configured R2 credentials.

Normal AWS scans need only `s3:ListBucket` on the selected bucket. R2 requires its account ID and a bucket-scoped S3 token with listing permission. Local inventory imports, counter comparisons, checkpoint diffs, and offline examples need no cloud credentials. See [setup](README.md#prerequisites).

Checkpoints and exports contain customer identifiers and usage. Keep them out of public repositories and issue reports. The CLI protects newly created files with restrictive permissions where the operating system supports them.

Use short-lived AWS credentials and bucket-scoped R2 tokens where possible. The code never needs `s3:GetObject` or write/delete permissions. SDK endpoint overrides in your environment can change AWS request destinations; review your environment before using production credentials.

No private security contact is documented yet. The maintainer must enable GitHub private vulnerability reporting or publish a monitored contact before npm release. If the repository offers Security → Report a vulnerability, use that private flow. Do not post credentials, customer data, or sensitive exploit details in public issues.

The opt-in live test and source-only scenario helper upload fake objects and delete their own fixture keys. They require write/delete permissions beyond the distributed CLI and refuse cloud writes without explicit opt-in. Use a disposable bucket without versioning or object lock. Read the [scenario instructions](../../docs/examples/scenario/README.md) before running them; failed cleanup can leave objects.

The npm package has not been published. Until releases exist, security fixes target the current `main` branch. No hosted service or billing correctness guarantee is included in this package.
