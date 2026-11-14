# 证据归档：w3c-understanding-1-4-3-contrast-minimum

- url: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- fetchedAt: 2026-11-15T04:55:00.000Z
- fetchMode: web_reader 全文（2026-11-15 M3 高风险修订取证会话）
- contentHash: sha256:<见 evidence-manifest.json>

## 关键引文（逐字）

> Large-scale text and images of large-scale text have a contrast ratio of at least 3:1

> with at least 18 point or 14 point bold or font size that would yield equivalent size for Chinese, Japanese and Korean (CJK) fonts

> The ratio between sizes in points and CSS pixels is 1pt = 1.333px, therefore 14pt and 18pt are equivalent to approximately 18.5px and 24px

> roughly equivalent to 1.2 and 1.5 em or to 120% or 150% of the default size for body text

## 说明

本文件为修订取证的关键引文归档；完整页面内容以 URL 为准（访问时间见 fetchedAt）。
归档位置：docs/m3-evidence/（随仓库版本化，卡片正文引用此路径）。

## 页面全文存档（web_reader，2026-11-15）

### Success Criterion (SC)
The visual presentation of text and images of text has a contrast ratio of at least 4.5:1, except for the following:
- Large Text: Large-scale text and images of large-scale text have a contrast ratio of at least 3:1;
- Incidental: Text or images of text that are part of an inactive user interface component, that are pure decoration, that are not visible to anyone, or that are part of a picture that contains significant other visual content, have no contrast requirement.
- Logotypes: Text that is part of a logo or brand name has no contrast requirement.

### Intent（大文本判定关键段全文）
Text that is larger and has wider character strokes is easier to read at lower contrast. The contrast requirement for larger text is therefore lower. … 18 point text or 14 point bold text is judged to be large enough to require a lower contrast ratio. (See The American Printing House for the Blind Guidelines for Large Printing and The Library of Congress Guidelines for Large Print under Resources.) "18 point" and "bold" can both have different meanings in different fonts but, except for very thin or unusual fonts, they should be sufficient.

Note: … The ratio between sizes in points and CSS pixels is 1pt = 1.333px, therefore 14pt and 18pt are equivalent to approximately 18.5px and 24px. … authors should ensure that the text in the resulting image is roughly equivalent to 1.2 and 1.5 em or to 120% or 150% of the default size for body text.

The 3:1 and 4.5:1 contrast ratios … should be treated as threshold values. When comparing the computed contrast ratio to the Success Criterion ratio, the computed values should not be rounded (e.g., 4.499:1 would not meet the 4.5:1 threshold).

### Key Terms: large scale
with at least 18 point or 14 point bold or font size that would yield equivalent size for Chinese, Japanese and Korean (CJK) fonts
Note 1: Fonts with extraordinarily thin strokes or unusual features … are harder to read, especially at lower contrast levels.
Note 3: For many mainstream body text fonts, 14 and 18 point is roughly equivalent to 1.2 and 1.5 em or to 120% or 150% of the default size for body text…

### Techniques（情形）
- Situation A: text is less than 18 point if not bold and less than 14 point if bold — G18（4.5:1）
- Situation B: text is at least 18 point if not bold and at least 14 point if bold — G145（3:1）
- Failures: F24；F83
