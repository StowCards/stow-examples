# Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please) and npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers). No npm token is stored anywhere.

The SDK lives in the `node/` folder of [StowCards/stow-examples](https://github.com/StowCards/stow-examples).
Version 1.0.0 was released from the former repository `StowCards/stow-node`, now archived; every later
release comes from this repository.

## How a release happens

1. Pull requests are squash-merged into `main` with [Conventional Commits](https://www.conventionalcommits.org/)
   titles. Only commits that change files under `node/` count towards an SDK release.
2. The `Release` workflow keeps a release pull request open that bumps `node/package.json`,
   `node/package-lock.json`, `node/src/version.ts` and `.release-please-manifest.json`, and updates
   `node/CHANGELOG.md`. Versions stay on 1.0.x: `release-please-config.json` (at the repository root)
   sets `"versioning": "always-bump-patch"`, so features and fixes alike move 1.0.4 to 1.0.5.
3. A maintainer reviews and merges the release pull request.
4. The workflow tags `node-vX.Y.Z`, creates the GitHub release, runs every check, publishes to npm with a
   provenance attestation and attaches a CycloneDX SBOM to the release.

The tag `node-v1.0.0` marks where this repository's history starts for the SDK (the last commit before
the SDK moved in), so release-please has a baseline and the first changelog link resolves. The 1.0.0
source itself is the `v1.0.0` tag of `StowCards/stow-node`.

npm checks that `repository` in `package.json` names the repository the workflow runs in, so it stays
`git+https://github.com/StowCards/stow-examples.git` with `"directory": "node"`. The directory is also
what makes the npm package page link to this folder rather than to the repository root.

## One-time setup

These must be in place before a release. Only the GitHub App is optional.

### GitHub (StowCards organisation)

1. The team `sdk-maintainers` (referenced by `.github/CODEOWNERS`) has write access.
2. **Settings → Code security**: private vulnerability reporting, Dependabot alerts, Dependabot security
   updates and secret scanning with push protection are on.
3. A ruleset protects `main`: a pull request with one approving review from Code Owners, the required
   checks of the `Examples`, `Node.js SDK`, `No breaking change`, `CodeQL` and `Dependency review`
   workflows, no force pushes, linear history.
4. **Settings → Actions → General** allows GitHub Actions to create pull requests (release-please needs
   this).
5. Optional: a GitHub App for releases, so the release pull request runs the required checks. GitHub starts no
   `pull_request` workflows for a pull request opened with the workflow's own `GITHUB_TOKEN`, so without
   the app the release pull request waits for checks that never start.
   - In the organisation's **Settings → Developer settings → GitHub Apps**, create a private app (for
     example `stow-release`) with webhooks off and these repository permissions: **Contents**, **Issues**
     (for the release labels) and **Pull requests**, each read and write.
   - Install it on `StowCards/stow-examples` only.
   - Generate a private key. In the repository's **Settings → Secrets and variables → Actions**, add
     the app's ID as the variable `RELEASE_APP_ID` and the private key (the whole `.pem` file) as the
     secret `RELEASE_APP_PRIVATE_KEY`.

   The `Release` workflow uses the app's token whenever `RELEASE_APP_ID` is set. Until it is, it falls
   back to `GITHUB_TOKEN`: a maintainer then closes and reopens each release pull request (or pushes a
   commit to its branch) to start the checks.

6. An environment named `npm` (**Settings → Environments**), limited to the `main` branch, with the
   maintainers as required reviewers if you want a manual gate before each publish.

### npm

1. The npm organisation `stowcards` requires two-factor authentication for its members.
2. On npmjs.com, the package's **Settings → Trusted publishing** has a GitHub Actions publisher:
   organisation `StowCards`, repository `stow-examples`, workflow `release.yml`, environment `npm`.
3. Still in the package settings, **Publishing access** is "Require two-factor authentication and
   disallow tokens", so only the workflow can publish.

From then on, every release follows the automated flow above.

## Checking a release

```bash
npm view @stowcards/sdk version repository
npm audit signatures   # in a project that depends on it: verifies the provenance attestation
```

## Hotfixes and pre-releases

- To force a version, add a `Release-As: 1.0.9` footer to a commit on `main` that changes `node/`. Keep it
  within 1.0.x.
- A broken release is fixed forward with a new patch release. Use `npm deprecate @stowcards/sdk@1.0.4 "reason"`
  rather than `npm unpublish`.
