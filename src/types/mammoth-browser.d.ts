declare module 'mammoth/mammoth.browser' {
  interface ExtractRawTextInput {
    arrayBuffer: ArrayBuffer;
  }

  interface ExtractRawTextResult {
    value: string;
    messages: unknown[];
  }

  const mammoth: {
    extractRawText(input: ExtractRawTextInput): Promise<ExtractRawTextResult>;
  };

  export default mammoth;
}
