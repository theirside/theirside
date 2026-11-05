# `ee/`: paid features

Code in this directory is public, but it is **not** free to use without a licence key. It is covered by the same [Fair Core License (FCL-1.0-ALv2)](../LICENSE) as the rest of the core (see [`LICENSING.md`](../LICENSING.md)):

- Using it requires a valid Theirside licence key (`THEIRSIDE_LICENSE_KEY` on a self-hosted install) or a cloud plan that includes the feature.
- Removing, disabling or bypassing the licence-key check, or changing this code to unlock it without a valid key, is not permitted (FCL "Limitations").
- Like the rest of the core, each release becomes available under Apache 2.0 two years after it is published.

Paying customers get the same code plus a licence key under separate commercial terms (order form/EULA, to follow).

v1 ships no paid features, so this directory only holds this README. Planned here (see the editions table in `docs/architecture.md` §2): provider SLA reports, network view, SSO/SAML, custom and granular roles (beyond the free admin and member), audit log, multiple orgs, extra and white-label status pages, custom status domains, paging integrations (PagerDuty, Opsgenie).

Rules:
- Core code never imports from `ee/` directly; `ee/` modules plug into interfaces defined in the core (alert channel adapters, `EntitlementsResolver`, …) and are gated by entitlements, never by `THEIRSIDE_DEPLOYMENT_MODE`.
- Cloud-only code (signup, billing, plan resolver, network aggregation service, licence issuing) does not belong here either; it lives in the private `theirside-cloud` repo.
