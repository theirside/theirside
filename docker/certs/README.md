# CA certificates in the collector image

`rds-global-bundle.pem` is AWS's global CA bundle for Amazon RDS (public root certificates
only, no keys), copied into the image as `/app/certs/rds-global-bundle.pem`. With it, a
collector on RDS verifies the database's certificate with only these settings:

    DATABASE_URL=postgres://user:pass@<instance>.rds.amazonaws.com:5432/theirside?sslmode=verify-full
    THEIRSIDE_DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem

It is kept in the repository so image builds are offline and reproducible, and a change to it
shows in review. AWS adds roots for new regions now and then; to refresh it:

    curl -fsSL -o docker/certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
    grep -c "BEGIN CERTIFICATE" docker/certs/rds-global-bundle.pem   # and no "PRIVATE KEY"
