# oxlint-plugin-jev

> [!WARNING]
> This package is experimental. Use at your own risk.

[Oxlint](https://oxc.rs/docs/guide/usage/linter.html) rules written in plain English, answered by [TypeSafe Jev](https://typesafe.ai).

A rule is a yes/no question about a function, a call, a JSX element, or a whole file. Each match is sent to Jev with the question, and the plugin reports an error when the yes-probability clears your cutoff.

## Install

```sh
npm i -D oxlint oxlint-plugin-jev
export TYPESAFE_API_KEY="..."   # https://console.typesafe.ai
```

In CI, set `ci: "fail"` so a run that could not reach Jev fails instead of passing quietly.

## Config

Add the plugin and its one rule, `jev/ask`, to `.oxlintrc.json`. Your English rules go in the options.

```json
{
  "jsPlugins": ["oxlint-plugin-jev"],
  "rules": {
    "jev/ask": [
      "error",
      {
        "rules": [
          {
            "id": "no-pii-in-logs",
            "target": "call",
            "question": "Does this call write personal data, such as an email or phone number, to a log or console?",
            "cutoff": 0.8
          },
          {
            "id": "name-matches-behavior",
            "target": "function",
            "question": "Does this function's name imply it only reads data, while its body also writes or sends something?",
            "cutoff": 0.6
          }
        ]
      }
    ]
  }
}
```

| Field      | What it is                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `id`       | Shown in the error message. Unique in the list.                                                      |
| `target`   | `"function"`, `"call"`, `"jsx"`, or `"file"`.                                                        |
| `question` | A yes/no question. "Yes" means "report this".                                                        |
| `cutoff`   | 0 to 1. Report when Jev's yes-probability is at or above it.                                         |
| `location` | Optional for file rules: a source-location `question` and a `cutoff` greater than 0.5 and at most 1. |

`target` decides what Jev gets to read. There is no selector syntax and no other target.

| Target       | Jev sees                                                                                                     | The error underlines |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| `"function"` | The whole function. An arrow or method includes its name, so `const getUser = () => ...` reads as `getUser`. | The signature line   |
| `"call"`     | The whole call expression.                                                                                   | The whole call       |
| `"jsx"`      | The whole element, children included.                                                                        | The opening tag      |
| `"file"`     | The whole file.                                                                                              | The first line       |

The wording of the question is the rule, so be precise about what counts. "Does this send personal data" also fires on a legitimate `mailer.send(user.email, ...)`. "To a log or console" does not.

File rules can point editor diagnostics and GitHub annotations to the suspected violation:

```json
{
  "id": "prefer-boolean-state-helper",
  "target": "file",
  "question": "Does any boolean React state have a memoized callback that only sets it to true or false?",
  "cutoff": 0.9,
  "location": {
    "question": "Select the declaration of the state used by the offending callback.",
    "cutoff": 0.75
  }
}
```

The violation and location have separate confidence cutoffs. An uncertain or invalid location keeps
the finding on the first line. Files truncated by `maxSnippetChars` also keep the first-line
diagnostic; location questions only use complete source. Rules without `location` behave as before.

| Setting             | Default        | Meaning                                                                                                                                            |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci`                | `"skip"`       | What happens when Jev can't be asked and `CI` is set. `"skip"` warns once and reports nothing. `"fail"` fails the run. Outside CI it always skips. |
| `timeoutMs`         | `10000`        | Per-file request timeout, retries included.                                                                                                        |
| `maxMatchesPerFile` | `25`           | Snippets sent per file across all rules. Extra matches are dropped in source order and the file is named on stderr.                                |
| `maxSnippetChars`   | `4000`         | Longer snippets are cut and end with `/* ...truncated */`.                                                                                         |
| `model`             | `"jev-latest"` | TypeSafe model id. Pin a versioned id such as `"jev-1.13.0"` once your cutoffs are tuned. Each diagnostic names the version that answered.         |

`TYPESAFE_BASE_URL` points the plugin at another host. The tests use it for a mock.

## How it works

One initial request per file, with every match in it. A file rule with `location` includes numbered
source and a Choice question. Above 254 nonblank lines, Jev selects a range and refines it in follow-up
requests with the same full-file context. All requests share the per-file `timeoutMs` budget.

Answers are cached under `node_modules/.cache/oxlint-plugin-jev`, keyed by the request. Changing a snippet or a question re-asks that file. Changing a cutoff or an `id` does not.

Location responses are cached too, including valid uncertain answers. Malformed location answers
are retried on the next run, including malformed entries already in the cache.

The request runs on a worker thread through the official [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) client, which retries rate limits and server errors within `timeoutMs`.

If Jev can't be asked, because the key is missing, the request times out, or the API errors, the plugin prints one warning and reports nothing for that file. Set `ci: "fail"` to fail the run instead.

If only a location refinement fails, confirmed violations are still reported at the file level.
Under CI with `ci: "fail"`, the refinement failure produces a separate diagnostic; otherwise it warns.
Later matches in that file keep their original locations without further refinement requests.

## In the editor

The oxlint VS Code extension lints as you type, and every keystroke inside a match is a paid request that blocks the language server until Jev answers.

Keep `jev/ask` out of the config your editor reads, and put it in an overlay for CI and pre-push. Leave `jsPlugins` in the base config, since the overlay inherits it.

```json
{
  "extends": [".oxlintrc.json"],
  "rules": {
    "jev/ask": ["error", { "rules": [ ... ] }]
  }
}
```

```sh
oxlint                        # editor and local runs, no Jev
oxlint -c .oxlintrc.ci.json   # CI and pre-push, Jev included
```

## Example

`example/` has three rules that a pattern-based linter can't express, a file that fails all three, and a file that passes.

| Rule                    | Fails on                                                | Passes on                                   |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------- |
| `no-pii-in-logs`        | `console.log("loaded", user.email, user.phone)`         | `console.log("notified", { userId: id })`   |
| `name-matches-behavior` | `getUser` that also sends an email                      | The same body named `notifySignIn`          |
| `no-prompt-injection`   | A customer message pasted into the system prompt string | The message passed as a separate user field |

```sh
npm run example
```

## Development

TypeScript, built with [Vite+](https://viteplus.dev). ESM only.

```sh
npm run build
npm run check   # format, lint, typecheck
npm test        # builds first, since the worker tests run against dist/
JEV_LIVE=1 TYPESAFE_API_KEY=... npm test   # also runs example/ against the real API
```

## License

MIT
