# Releasing an update

Installed copies look for a newer version when they start, and offer it on the first
screen. New features, layouts, card designs, text designs and fonts all reach studios this
way, because they ship inside the app.

## Once, before the first release

1. Back up the signing key somewhere safe and private. It was made on the developer's
   computer as `~/.tauri/eventor-updater.key`. It must never be committed. **If it is lost,
   no installed copy can be updated again**; if it leaks, anyone could sign an update.
2. Add it to the GitHub repository's Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` (the
   whole text of the file). `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are the same
   as for the macOS dev build.
3. Copies older than the first release with the updater must be installed by hand once.

`release.yml` has to be on the default branch before GitHub will run it.

## Each release

1. Raise `version` in `src-tauri/tauri.conf.json`. An update must have a higher version than
   the copy it replaces.
2. Merge to the branch to release from.
3. On GitHub, open **Actions → Release → Run workflow**, choose the branch, and write what is
   new in plain words. Studios read this.
4. When it finishes, open **Releases**, try the draft's installers, and press **Publish**. It
   must not be marked as a pre-release.

Studios are offered it the next time they start the app. The address they look at is
`releases/latest/download/latest.json`.

## Taking back a bad release

Delete it, or mark it as a pre-release, so that the one before is the latest again. Copies
that already updated stay on it, so fix the problem and release a higher version.

## Trying it on a computer

A debug copy ignores releases. It looks for updates only when both `EVENTOR_UPDATE_URL` and
`EVENTOR_UPDATE_KEY` are set, and a release copy ignores those.
