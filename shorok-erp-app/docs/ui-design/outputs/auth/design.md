# Auth — Design Spec

Source: `specs/main/spec.md` (Sign-in flow), `docs/ui-design/outputs/00-design-system/design.md` (typography, colors, components).

Default locale Arabic (`ar-EG`, RTL); English (`en`, LTR) toggle.

## Screens

### 1. Login (`/[locale]/login`)

Layout: full-viewport centered card on a neutral background.

```
┌──────────────────────────────────┐
│            شروق                  │   ← brand mark, RTL-mirrored in en/ar
│      نظام إدارة المؤسسة          │   ← tagline
│                                  │
│   تسجيل الدخول                    │
│   أدخل رقم هاتفك وكلمة المرور.    │
│                                  │
│   رقم الهاتف                       │
│   [+201XXXXXXXXX            ]   │   ← phone input, dir="ltr" so digits read L→R
│                                  │
│   كلمة المرور                     │
│   [••••••••                  ]   │
│                                  │
│   [    دخول    ]  [اللغة ▾]      │
└──────────────────────────────────┘
```

Card width: `max-w-md` (≈ 28rem). Padding: `p-8`.

#### Fields

- **Phone**: text input, `inputMode="tel"`, `dir="ltr"` *always* (digits + `+` are LTR even in RTL locale). Placeholder: real example (`+201XXXXXXXXX`). Validation: liberal — server normalizes via `libphonenumber-js`. Inline error appears under the input.
- **Password**: type=password, `dir="ltr"`. Min length 8 client-side; server enforces.
- **Submit button** (`اسم: دخول | en: Sign in`): full-width, primary color. Disabled while submitting; shows spinner + `جارٍ تسجيل الدخول…` / `Signing in…`.
- **Language switcher**: `[ع | EN]` toggle in the card footer. Toggles between `/ar/login` and `/en/login` preserving any query.

#### States

| State                     | Visual |
|---------------------------|--------|
| Idle                      | Form normally rendered. |
| Submitting                | Button disabled + label changes; inputs read-only. |
| `invalid_credentials`     | Inline alert above the form: `errors.invalid_credentials` localized. |
| `user_disabled`           | Inline alert: `errors.user_disabled`. |
| Network error             | Inline alert: `errors.network_error`. |

#### Direction & layout rules

- The card uses logical-property classes (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`) only. **No** `ml-/mr-/pl-/pr-/left-/right-`.
- `<html>` carries `dir="rtl"` for `ar`, `dir="ltr"` for `en`. The card itself does not need a `dir` override.
- Phone and password fields override `dir="ltr"` locally so digits and password characters render left-to-right regardless of locale.

#### Real text — never keys

Both AR and EN copy live in `apps/web/messages/{ar,en}.json` under the `auth.*` namespace. The lint rule from T047 forbids string literals in JSX outside of `t()` / `<Trans>`.

### 2. Token-expired re-auth dialog

When the API returns `token_expired` and the auto-refresh fails, the app navigates to `/[locale]/login?redirect=<encoded current path>` and shows a small notice strip above the form: `errors.token_expired`. After successful login the user is redirected back.

## Navigation

- Successful login → `/[locale]/dashboard`.
- Already-authenticated user visiting `/login` → redirect to `/[locale]/dashboard`.

## Phone normalization rule (server-side, mirrored client-side)

Server uses `libphonenumber-js` with default country `EG` so:

| User types          | Stored / used as |
|---------------------|------------------|
| `01000000000`       | `+201000000000`  |
| `+201000000000`     | `+201000000000`  |
| `00201000000000`    | `+201000000000`  |
| anything not parseable | rejected with `invalid_credentials` (we never reveal whether the phone exists) |

The login form does **not** auto-format. The server normalizes — that's the single source of truth (Constitution Principle II: server-authoritative).

## Accessibility

- Labels are linked to inputs via `htmlFor`. Errors use `aria-live="polite"`.
- Submit triggers on Enter from any field.
- Color contrast: alert + button states meet WCAG AA against the design system's neutral background.
