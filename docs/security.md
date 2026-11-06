# Dashboard accounts and security

How people sign in to a self-hosted collector, and what to set up and keep safe. Everything here is in the free edition, including the admin and member roles (custom roles, SSO and an audit log are paid features). What is stored about users: [privacy.md](privacy.md#dashboard-users).

## First run

When nobody can sign in yet, the dashboard shows a **setup page** that creates the first account. It asks for one of:

- the **setup code** each collector prints to its log at start (valid 24 hours, upper-case, e.g. `K7QM-2XRD-9BTW`):
  ```sh
  docker compose -f docker/docker-compose.yml logs collector | grep "setup code"
  ```
- or the collector's **`THEIRSIDE_ADMIN_TOKEN`**.

Then name, email and password. Without `THEIRSIDE_BOOTSTRAP_API_KEY` the setup page also creates the org and project; create API keys under Settings → API keys afterwards. Installs that used the admin token before keep their data: the setup page turns the old placeholder admin into your account.

## Accounts

- **Passwords**: at least 12 characters, no other rules (a passphrase is fine). Stored as argon2id hashes.
- **Invites** (Settings → Users): a link that works once and expires after 7 days. The dashboard always shows it to copy; with SMTP configured (`THEIRSIDE_SMTP_*`, the same settings as email alerts) it is also emailed.
- **Password reset**: any user can make a reset link for someone else (Settings → Users → Reset link; works once, 1 hour). With SMTP, "Forgot password?" on the sign-in page emails one. A reset signs the user out everywhere and lifts their sign-in delays; it doesn't turn off their 2FA.
- **Sessions**: an `HttpOnly`, `SameSite=Strict` cookie, `Secure` when the dashboard is served over https. A session ends after 7 days (`THEIRSIDE_SESSION_MAX_AGE_HOURS`) or 24 hours without use (`THEIRSIDE_SESSION_IDLE_HOURS`). **Sign out everywhere** (your account page) ends all of yours; Settings → Users → Sign out ends someone else's; changing your password ends your other sessions.
- **Removing a user** takes effect at once. Nobody can remove themselves or the last user who can sign in.

## Changes to someone else's account

Making a password reset link for someone, turning off their 2FA, changing their role or removing them asks **who you are again** first (step-up): your password, plus a code from your authenticator app when your own 2FA is on (a recovery code works too). Wrong answers count like wrong sign-ins. So an unlocked laptop or a stolen session cookie isn't enough to take over another account.

- Signed in with the **admin token**, you enter the token again. Scripts using `Authorization: Bearer` aren't asked; they just sent it.
- Through an **identity proxy**, you aren't asked: there is no password, and the proxy signs you in on every request.
- With **SMTP** configured, the person is emailed who did it: "Ada (ada@example.com) turned off two-factor sign-in for your Theirside account…". When their reset link is emailed to them, that email is the notice. Signing someone out (Settings → Users → Sign out) doesn't ask or email.

## Roles

Each user is an **admin** or a **member** (Settings → Users).

| | Admin | Member |
|---|---|---|
| See providers, endpoints, incidents, SDK health, settings | yes | yes |
| Copy incident summaries; health API (with an API key) | yes | yes |
| Manage providers: rename, hide, alerts on/off, merge, split, support contact, path privacy, allowed path words | yes | yes |
| Own account: password, 2FA, sign out everywhere | yes | yes |
| Users, invites and roles; other users' 2FA, reset links, sign-out, removal | yes | no |
| API keys, alert channels and thresholds (project and per provider), the new-provider digest | yes | no |
| Status pages, and which providers they show | yes | no |
| Security settings (require 2FA) | yes | no |

The collector enforces this on every request (403 "Only admins can …"); the dashboard just hides what members can't use. Trusted proxy settings and the licence are environment variables, so only whoever runs the collector changes them.

- The user from the setup page is always an admin, whatever `THEIRSIDE_ADMIN_EMAILS` says (that list is only for accounts an identity proxy creates). Invites pick the role (member by default).
- Users created by an identity proxy are members, unless their email is in **`THEIRSIDE_ADMIN_EMAILS`** (comma-separated, e.g. `alice@example.com,ops@example.com`). Without that list, the very first user is the admin. The list only applies when the account is created; change roles later on Settings → Users. An invite's role applies when the invitee signs in through the proxy.
- There is always an admin: the last admin who can sign in can't be demoted or removed. Make someone else an admin first.
- Changing a role asks for step-up like other changes to someone's account, and emails them.
- The admin token acts as an admin. If no admin can sign in any more, use it to make someone an admin.
- Upgrading from a version without roles makes every existing user an admin (they could do everything before); pending invites also make admins.

## Brute-force protection

- **Per email and address**: 4 wrong passwords or 2FA codes for one email from one address are free; after that, each failure makes that email wait at that address 1 second, then 2, 4, 8… up to 15 minutes, even for the right password. A success, or a day, starts the count over. Because the address is part of the key, someone guessing from their own address never slows the real user down at theirs, and nobody can lock an account. Emails without an account are delayed exactly the same way, so the answers never reveal who has one. Confirming your password for a sensitive change counts the same way.
- **Per address**: 30 failures from one address within 15 minutes block that address for 15 minutes, whatever the email (passwords, 2FA codes, admin token, setup code, unknown links). This is the hard limit on guessing many accounts, or one account, from one place; it never affects other addresses.
- 3 reset emails per email address per hour.
- Counts are kept in Postgres, so they hold across replicas, and are forgotten after a day.
- Someone guessing from many addresses gets 4 free tries and then slowly growing delays at each, besides the per-address limit; long passwords (12+ characters, hashed with argon2id) and 2FA are what make that hopeless.

The address is the client IP as the collector sees it. **`THEIRSIDE_TRUST_PROXY`** decides whose `X-Forwarded-For` to believe:

- **Default**: proxies on private or loopback addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `fc00::/7`, `::1`), which covers a load balancer or ingress in the same VPC or on the same host. A client connecting from the internet can't pick the address its attempts count against.
- **CIDRs** (`10.0.12.0/24,10.0.13.0/24`): only these; set your load balancers' subnets to be stricter than the default. If anything else on the private network can reach the collector directly, it could otherwise send its own `X-Forwarded-For`.
- **A number**: that many proxies nearest the collector, whatever their address.
- **`false`**: none; the address is always the TCP peer.
- **`true`**: anyone, which is only right when nothing reaches the collector except through your proxy. The collector logs a warning at start.

## Cross-site requests (CSRF)

Every change made with a session cookie (or through an identity proxy) needs the `x-csrf-token` header the dashboard gets at sign-in, and a request from another site (`Origin` or `Sec-Fetch-Site`) is refused, including sign-in itself. Scripts using `Authorization: Bearer <THEIRSIDE_ADMIN_TOKEN>` don't need it.

## Two-factor sign-in (2FA)

Each user can turn on an authenticator app (TOTP) on their account page and gets 10 single-use recovery codes. Settings → Users → **Require two-factor sign-in for everyone** makes it mandatory: users without it can then only set it up, on existing sessions too.

2FA needs **`THEIRSIDE_SECRET_KEY`**, which encrypts the authenticator secrets in the database:

```sh
openssl rand -base64 32   # at least 32 characters
```

- **Back it up** with your other secrets (password manager, AWS Secrets Manager…), separately from database backups: a database dump alone doesn't reveal the secrets, and the key alone is useless.
- **If it is lost** (or the collector starts with a different one), codes can't be checked: the log says how many users are affected, sign-in answers "Two-factor codes can't be checked", and users sign in with a recovery code; then another user turns their 2FA off (Settings → Users → Turn off 2FA) and they set it up again. Without a working account, sign in with the admin token to do that.
- **Rotating it**: set the new key as `THEIRSIDE_SECRET_KEY` and the old one in `THEIRSIDE_SECRET_KEY_PREVIOUS` (comma-separated for several), restart all collectors. Each start re-encrypts every secret with the new key (the log says how many). Once every replica has restarted, remove the old key.
- A lost phone: sign in with a recovery code, or ask another user to turn your 2FA off.

## Sign-in through an identity proxy

If the dashboard already sits behind something that signs people in with your company account, the collector can take the identity from it. Off unless you set `THEIRSIDE_AUTH_PROXY`.

The identity header is only believed when the connection comes from an address in **`THEIRSIDE_AUTH_PROXY_TRUSTED_IPS`** (required; the proxy's addresses or subnets). The collector checks the TCP peer, not `X-Forwarded-For`, and ignores the header from anyone else. So the collector must not be reachable except through the proxy, and the proxy must always overwrite the header.

People need an account: an invite (Settings → Users; they don't need to open the link, signing in through the proxy accepts it) or `THEIRSIDE_AUTH_PROXY_AUTO_CREATE=true`, which creates an account for everyone the proxy lets through (as members; see [Roles](#roles) for `THEIRSIDE_ADMIN_EMAILS`). Proxy users have no password, aren't asked for 2FA by Theirside (your identity provider handles MFA), and sign out at the proxy. Password accounts and the admin token keep working alongside.

### Generic header (oauth2-proxy, Pomerium, Cloudflare Access, …)

```sh
THEIRSIDE_AUTH_PROXY=header
THEIRSIDE_AUTH_PROXY_HEADER=X-Forwarded-Email        # oauth2-proxy: X-Auth-Request-Email with --set-xauthrequest
THEIRSIDE_AUTH_PROXY_TRUSTED_IPS=10.0.12.0/24        # where the proxy connects from
```

### AWS Application Load Balancer

Add an **authenticate-oidc** (or Cognito) action before the forward action on the dashboard's listener rule. The ALB then sends a signed `x-amzn-oidc-data` token, which the collector verifies (ES256, with the public key AWS publishes for your region, fetched once per key from `public-keys.auth.elb.<region>.amazonaws.com`, so the collector needs outbound HTTPS to it):

```sh
THEIRSIDE_AUTH_PROXY=alb
THEIRSIDE_AUTH_PROXY_ALB_ARN=arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/theirside/50dc6c495c0c9188
THEIRSIDE_AUTH_PROXY_TRUSTED_IPS=10.0.0.0/24,10.0.1.0/24   # the ALB's subnets
```

The token must be signed for that ALB (`signer`), unexpired and contain an `email` claim (request the `email` scope from your identity provider).

## The admin token (break-glass)

`THEIRSIDE_ADMIN_TOKEN` signs in without an account ("Use the admin token" on the sign-in page) and works as `Authorization: Bearer` for scripts. It is never asked for 2FA, so treat it like a root password: a long random value (`openssl rand -hex 24`) in your secret store, used to complete setup or to recover when nobody can sign in. Wrong tokens count against the address like wrong passwords. Unset it to turn it off; the setup page then needs the setup code from the log.
