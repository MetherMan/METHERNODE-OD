# Mely Reference Material assets

The v0.7 Mely theme uses visual references supplied by the vault owner for this private Obsidian plugin.

## v1.6 source-parity chrome

The vault owner supplied four final layout boards named `1`, `2`, `3`, and `4`. They are the authoritative composition references for Ribbon Slash, Tidal Crescent, Horn Slash, and Portrait Echo. Each v1.6 chrome asset was produced as a precise cleanup edit of its corresponding supplied board: all characters, character-derived crops, readable document copy, numbers, barcodes, and metadata were removed, while the original panel geometry, diagonal cuts, crescent, collage, rules, borders, textures, echo field, and navigation frames were preserved. The cleared regions were reconstructed from the surrounding paper, black field, grunge, or collage.

- `assets/mely-ribbon-slash-chrome.png` derives from supplied board `1`.
- `assets/mely-tidal-crescent-chrome.png` derives from supplied board `2`.
- `assets/mely-horn-slash-chrome.png` derives from supplied board `3`.
- `assets/mely-horn-slash-foreground.png` is a transparent extraction of the two foreground dry-brush slashes from supplied board `3`. The extraction was produced as a precise-object edit on a green chroma field, then converted locally to alpha transparency. It contains no character, title, metadata, or navigation content and is rendered above the live character image.
- `assets/mely-portrait-echo-chrome.png` derives from supplied board `4`.
- `assets/mely-black-tide-chrome.png` is the previously approved fifth chrome and is unchanged in v1.6.

The chrome and foreground files are fixed decorative layers only. Runtime character art, headings, prose, facts, echo copies, and navigation labels are rendered as live DOM from the `mn-codex` block. No complete preview board is used as the rendered page.

## Source roles

- `2b32170b431866aec44a03149c596ec2.jpg`: black-and-white brush texture reference.
- `77f7c614f029c46a0d0a5da43c504a27.jpg`: architectural grid and photocopy-collage reference.
- `979a4435577c5ad7d787eaf207ec070e.jpg`: black feather material; processed as `assets/mely-black-feather.webp`.
- `다운로드 (3).png`: vertical gothic linework; processed as `assets/mely-ornament-vine.webp`.
- `다운로드 (2).png`: gothic linework and handwritten texture reference.
- `48b22e5de5f52cef028dad990c8e1ce6.jpg`: detailed wing engraving; processed as `assets/mely-wing-etching.webp`.

`assets/mely-reference-spread.webp` is a generated composite derived from five of the supplied references. It contains no character, face, statue, invented logo, or invented symmetrical emblem. The remaining vertical ornament was cleaned locally and placed directly in the CSS.

## Generation prompt

```text
Compose the supplied visual materials into a refined Mely editorial background plate for a wide two-page Obsidian codex. Use the rough black/white brush painting, architectural blueprint-grid collage, black feather wing, and thin gothic ornamental line drawings. Left page: deep charcoal brush texture and a large cropped black feather wing. Right page: pale frost-white with a restrained architectural grid/collage and supplied gothic linework along the margins. Preserve readable negative space and a quiet center seam. Black, warm white, graphite, fog grey, and restrained icy mint. No human or angel face, statue, character, invented emblem or logo, invented wing symbol, halo, sword icon, barcode, legible text, or watermark.
```
