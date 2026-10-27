# Support

| You need                                | Go to                                                              |
| --------------------------------------- | ------------------------------------------------------------------ |
| API reference, webhooks, concepts       | [stow.cards/developers](https://stow.cards/developers/)            |
| A bug in the SDK, or a feature request  | [GitHub issues](https://github.com/StowCards/stow-examples/issues) |
| A security vulnerability                | [SECURITY.md](../SECURITY.md) (never a public issue)               |
| Help with your account, billing or data | [Stow Cards contact page](https://stow.cards/contact.html)         |

When you report a problem with an API call, include the request id from `error.requestId` (or
`response.requestId` from `.withResponse()`), the SDK version and your Node.js version. Never include an
API key or webhook secret.

## Support policy

- Versions stay on 1.0.x and only add to the public API, so the latest 1.0.x release is the supported
  one: it receives every feature, fix and security update, and upgrading to it is always safe.
- Each Node.js release line is supported until its upstream end of life.
