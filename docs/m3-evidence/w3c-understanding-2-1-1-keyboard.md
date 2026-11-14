# 证据归档：w3c-understanding-2-1-1-keyboard

- url: https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html
- fetchedAt: 2026-11-15T04:56:00.000Z
- fetchMode: web_reader 全文（2026-11-15 M3 高风险修订取证会话）
- contentHash: sha256:<见 evidence-manifest.json>

## 关键引文（逐字）

> All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes, except where the underlying function requires input that depends on the path of the user's movement and not just the endpoints.

> Free hand drawing, or watercolor painting require path dependent input.

> Drawing straight lines, regular geometric shapes, re-sizing windows and dragging objects to a location (when the path to that location is not relevant) do not require path dependent input.

> Example 2: A drag and Drop Feature — An application that uses drag and drop also supports "cut" and "paste" or form controls to move objects.

## 说明

本文件为修订取证的关键引文归档；完整页面内容以 URL 为准（访问时间见 fetchedAt）。
归档位置：docs/m3-evidence/（随仓库版本化，卡片正文引用此路径）。

## 页面全文存档（web_reader，2026-11-15）

### Success Criterion (SC)
All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes, except where the underlying function requires input that depends on the path of the user's movement and not just the endpoints.

Note 1: This exception relates to the underlying function, not the input technique. For example, if using handwriting to enter text, the input technique (handwriting) requires path-dependent input but the underlying function (text input) does not.

Note 2: This does not forbid and should not discourage providing mouse input or other input methods in addition to keyboard operation.

### Intent（节选全文）
The intent of this success criterion is to ensure that, wherever possible, content can be operated through a keyboard or keyboard interface (so an alternate keyboard can be used). … The phrase "except where the underlying function requires input that depends on the path of the user's movement and not just the endpoints" is included to separate those things that cannot reasonably be controlled from a keyboard.

Most actions carried out by a pointing device can also be done from the keyboard (for example, clicking, selecting, moving, sizing). However, there is a small class of input that is done with a pointing device that cannot be done from the keyboard in any known fashion without requiring an inordinate number of keystrokes. Free hand drawing, or watercolor painting require path dependent input. Drawing straight lines, regular geometric shapes, re-sizing windows and dragging objects to a location (when the path to that location is not relevant) do not require path dependent input.

The use of MouseKeys would not satisfy this success criterion because it is not a keyboard equivalent to the application; it is a mouse equivalent (i.e., it looks like a mouse to the application).

### Examples
Example 1: A drawing Program — A drawing program allows users to create, size, position and rotate objects from the keyboard.
Example 2: A drag and Drop Feature — An application that uses drag and drop also supports "cut" and "paste" or form controls to move objects.
Example 3: Moving between and connecting discrete points — A connect-the-dots program allows the user to move between dots on a screen and use the spacebar to connect the current dot to the previous one.
Example 4: Exception - Painting Program — A watercolor painting program passes as an exception because the brush strokes vary depending on the speed and duration of the movements.
Example 5: Exception - Model helicopter flight training simulator — passes as an exception because the nature of the simulator is to teach real-time behavior of a model helicopter.

### Techniques（情形）
- G202: Ensuring keyboard control for all functionality
- G90: Providing keyboard-triggered event handlers（H91/PDF3/PDF11/PDF23；SCR20/SCR35/SCR2）
- Failures: F54（仅指针事件处理器）；F55（脚本移除焦点）；F42（模拟链接）
