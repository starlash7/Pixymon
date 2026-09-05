# Pixymon V2 blind evaluation rubric

## Sample

- Compare 36 baseline/V2 pairs in the protocol-only milestone: 24 originals (Bite or Withhold) and 12 Revisit/accountability cases. Record the observed Bite/Withhold mix, but never manufacture weak candidates to fill a format quota. Lane and format come from the bound replay row. Evolution cannot fill an original-post cell. Revisit cases may come from real, timestamped shadow tracking; shadow provenance must remain in the private source artifacts and must never count as a live publication.
- Hide system name, version, provider, and ordering. Randomize A/B independently per pair.
- Use two Korean crypto-native readers. A score difference of two or more points between readers requires adjudication.
- Reader 2 independently reviews a stratified 20% sample and every edit/reject/hard-veto case during the operating period.

## Hard veto

Any one of these fails the candidate regardless of average score:

- fabricated or changed name/number/time
- unsupported causal or investment-certainty claim
- malformed, truncated, or meaning-repeating Korean
- stale or provenance-free fact
- duplicate public post
- language or target mismatch

## Score each axis from 1 to 5

1. `grounding`: every public claim is supported by the shown evidence card.
2. `clarity`: the Korean reads naturally once, without decoding internal jargon.
3. `insight`: the post adds a non-obvious judgment instead of restating the metric.
4. `character`: selective curiosity, skepticism, patience, energy, or humility feels like one being.
5. `memorability`: the judgment and the character's accountability stance remain legible after reading the pair.
6. `followWorthiness`: the reader wants to see the +24h/+72h return.
7. `overall`: independent holistic score, not an arithmetic average.

Also record:

- A/B preference or tie
- publish unchanged: yes/no
- anonymous Pixymon identification among three account descriptions: yes/no
- optional edit and concise reason tags

Each annotation scores both anonymous sides (`scores.A` and `scores.B`) and records all booleans and veto/tag lists by side. Use only `reader-1` and `reader-2`; use `adjudicator-1` (or the next numeric pseudonym) for adjudication. Never write a name, handle, email, or OS username into a tracked annotation. The reviewer-facing pack never contains the private A/B version mapping, provider identity, source URL, or baseline/V2 labels. Store the private mapping separately and reveal it only to the offline aggregator after both readers finish. The public pack and private mapping carry a shared commitment and content digest; aggregation must receive and verify both. Missing second-reader rows, required fields, or adjudications make the report incomplete rather than implicitly negative or zero.

## Promotion gate

- hard veto: `0`
- grounding and clarity mean: `>=4.0`
- character and memorability mean: `>=3.7`
- overall mean: `>=3.8`
- V2 preference over baseline: `>=60%`
- publish unchanged: `>=80%`
- anonymous Pixymon identification: `>=70%`

The rubric result is evidence for manual promotion. The pack builder and aggregator bind every V2 side to its strict replay row and verified commit; rollout status also checks the raw replay artifact against the ledger and machine evidence. A protocol-only sample cannot satisfy three-lane coverage.
