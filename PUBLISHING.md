# Publishing the source safely

The public source uses fictional identifiers and explicit placeholders. Your working `.env`, task records, and browser draft remain local so you can continue testing. They are not part of a source release.

## Credentials and identifiers

| Item | Where it can appear | Publish it? |
| --- | --- | --- |
| `AGORA_CUSTOMER_ID` and `AGORA_CUSTOMER_SECRET` | `.env`, copied REST requests, Basic Authorization headers | No. Together they authenticate Agora REST calls. |
| `META_USER_ACCESS_TOKEN` and `META_PAGE_ACCESS_TOKEN` | `.env`, Graph API Explorer, copied requests | No. They grant access to the corresponding profile or Page. |
| RTC tokens | Audio/video/browser fields, request JSON, browser drafts | No. Use angle-bracket placeholders in examples. |
| Facebook stream key / complete RTMP(S) URL | Destination fields, request JSON, screenshots | No. Preserve it privately for testing; the signed query is part of the credential. |
| Agora builder token | `.runtime/tasks.json`, URLs containing `builderToken` | No. Keep runtime records private. |
| Agora App Certificate, if stored elsewhere | Other local configuration or scripts | No. This demo does not use one. |
| Agora App ID, Facebook Page/profile/video IDs, channel names, UIDs | Configuration, logs, screenshots | Not authentication secrets, but they identify accounts or sessions. Public examples use fictional values. |

`.env.example` contains empty credential fields and is safe to commit. Test fixtures contain fake values, not working credentials.

## Files to exclude

The included `.gitignore` excludes `.env` and its variants, `.runtime/`, `node_modules/`, `.release/`, test output, coverage, logs, and downloaded diagnostic reports. It explicitly allows `.env.example`.

GitHub's web uploader and manually created archives do not apply `.gitignore` automatically. Upload only reviewed source files, or use the prepared source archive. Do not upload the entire working directory without filtering it.

Browser local storage is outside the repository, but contains the saved tokens, request JSON, and streaming URL. Clear this site's browser data when you finish testing. Avoid screenshots of populated token, URL, or JSON fields. Redacted reports can still contain account and session metadata.

## Before your first push

1. Run `npm test`.
2. Review `.env.example`, the sample configuration, screenshots, and any added example payloads.
3. Review the exact files staged for commit with `git diff --cached` and `git ls-files`.
4. Confirm that `.env`, `.runtime/`, reports, and archives are absent from the tracked files. `.gitignore` does not untrack files that were committed earlier.
5. Enable GitHub secret scanning and push protection if available for your repository.

If a real secret was already committed, uploaded, or otherwise shared, revoke or rotate it at the issuing service. Removing it from the latest commit is not sufficient to invalidate it or remove it from history. No Git history existed in this demo directory at the time of this cleanup.

Source publication does not require stopping a cloud task. Keep private runtime records until all cloud tasks are stopped and no longer need to be queried or destroyed.
