/**
 * @file src/types/mammoth.d.ts
 * @description Minimal ambient type declarations for the `mammoth` package
 * (Word document → plain text / HTML converter).
 *
 * No `@types/mammoth` package exists on npm.  We declare only the surface
 * of the API that this project uses: `extractRawText({ buffer })`.
 *
 * If additional mammoth APIs are needed (convertToHtml, convertToMarkdown,
 * etc.) their signatures should be added here.
 */

declare module 'mammoth' {

  /** Diagnostic message produced during conversion. */
  interface Message {
    type:    'warning' | 'error';
    message: string;
  }

  /** Return value of `extractRawText()`. */
  interface RawTextResult {
    /** Plain text extracted from the Word document. */
    value:    string;
    /** Warnings or errors encountered during extraction. */
    messages: Message[];
  }

  /**
   * Extract the plain-text content of a `.docx` Word document.
   *
   * @param input - Source of the Word document.  Pass `{ buffer }` when the
   *   document content is already in memory as a `Buffer`.
   * @returns Promise resolving to an object with the extracted plain text.
   *
   * @example
   * ```ts
   * const result = await mammoth.extractRawText({ buffer: attachmentBuffer });
   * console.log(result.value); // → plain text
   * ```
   */
  function extractRawText(input: { buffer: Buffer }): Promise<RawTextResult>;

  export { extractRawText };
  export type { Message, RawTextResult };
}
