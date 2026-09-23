# ADR 0012: Keep the name Goobster and stay MIT through the pilot

Date: 2026-09-22
Status: Accepted. The trademark and domain search result is still to be recorded (see *Before any public listing*).

Decision record for [issue #262](https://github.com/nervous-rob/goobster/issues/262), part of the
[roadmap](https://github.com/nervous-rob/goobster/issues/246). It closes the
naming exploration in [product_naming_exploration.md](../product_naming_exploration.md)
and [spec §11](../shared_instance_product_spec.md#11-open-naming-exploration)
for the duration of the pilot, and settles the licensing question that came up
in the second roadmap review.

## Context

Two questions had been left open while the shared-instance work landed:

1. **The name.** The naming exploration listed candidates (Trestle, Fieldnote,
   Waymark, ...) for a product name distinct from the assistant's name, but no
   candidate had been checked for domains, trademarks or availability, and no
   rename was selected. Every package, environment variable, URL, stored-data
   key and public API still says Goobster.
2. **The license.** The repository is MIT (`LICENSE`, `package.json`). The
   review asked whether selling hosting or support later would need a copyleft
   or source-available license, and whether the point economy (Jimbucks and the
   exchange) should stay in the product at all.

The pilot ([#265](https://github.com/nervous-rob/goobster/issues/265)) is a
private, single-user run where the instance owner is both user and buyer. Nothing
in it depends on a product name or a license change, and either change carries a
cost that is not justified until someone has shown they will pay.

## Decision

### Name

- **Keep Goobster** for the product and the assistant through the pilot. Nothing
  is renamed: not the npm packages (`@goobster/core`), the `GOOBSTER_*`
  environment variables, the routes, the database, the Docker images or the
  documentation.
- **Do the trademark and domain search before any public listing.** A public
  listing means anything that presents the software to strangers under the name,
  for example the self-hosting channel packaging in
  [#259](https://github.com/nervous-rob/goobster/issues/259), a directory or
  marketplace entry, or a hosted sign-up page. The search covers the word mark in
  the software and online-services classes in the jurisdictions the listing would
  reach, and the obvious domains. **The result is recorded in this ADR whether it
  is clear or not.** An unclear result does not by itself force a rename; it
  reopens the exploration with the search evidence attached.
- **Jimbucks and the exchange stay inside the optional economy.** They are not
  removed and they are not made part of the core promise. They sit behind the
  host switch in [#261](https://github.com/nervous-rob/goobster/issues/261) and
  are **off by default on new installs**, so a new operator never ships gambling
  or a currency without choosing to.

### License

- **Stay MIT.** Selling hosting, support or a managed instance does not require a
  license change: MIT permits it, and the operator of a hosted instance owes
  nothing beyond the notice.
- A move to a copyleft license (for example AGPL) or a source-available license is
  **not on the table** until two conditions hold: **someone has shown they will
  pay**, and the project has completed **a copyright audit of past
  contributions plus legal advice**. Relicensing needs the agreement of every
  contributor whose work would be relicensed, so the audit comes first.
- For the record, because the second review got this wrong: **AGPL permits
  commercial hosting by others.** It adds source-availability obligations for
  network use; it does not give the project exclusive hosting rights. Choosing it
  would not stop a third party from running Goobster as a service.
- **No change to `LICENSE` or `package.json`.**

## Consequences

- Documentation, release artifacts and code keep using Goobster. The naming
  exploration document stays as a record of candidates but is no longer an open
  question for the pilot.
- The economy's default-off state is a host switch, delivered by #261, not a
  removal. Existing installs that already run the economy are unaffected by the
  default.
- Packaging work (#259) has a hard prerequisite: the search below must be filled
  in first.
- Any future proposal to relicense must reference this ADR and include the
  contributor audit.

## Conditions for revisiting

| Decision | Revisit when |
|---|---|
| Keep the name | The trademark or domain search returns a conflict, or the pilot's exit decision is to change direction (#265). |
| Stay MIT | A paying customer exists **and** the copyright audit plus legal advice are done. Not before. |
| Economy default off | A host has measured demand for it in a shared instance and the gambling attestation in #261 is in place. |

## Before any public listing: trademark and domain search

To be filled in when the search is done. Record the date, who did it, what was
searched (word mark, classes, jurisdictions, domains), and the result, including
any conflicts found. Leave nothing implied: a clear result and an unclear result
are both written here.

| Item | Result |
|---|---|
| Date | *not yet done* |
| Word mark searched | Goobster |
| Classes and jurisdictions | *not yet done* |
| Domains checked | *not yet done* |
| Conflicts found | *not yet done* |
| Outcome | *not yet done* |
