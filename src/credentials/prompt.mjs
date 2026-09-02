// Reading a secret from the operator without it ever being visible.
//
// Barry's standing rule, and the reason there is no `--key <value>` flag
// anywhere in this CLI: a secret passed as a command-line argument lands in
// shell history, in the process table, and in any terminal recording. It is
// typed at a prompt, echoed nowhere, and goes straight to the credential store.
//
// Written as a module with injected streams because the fiddly part is real:
// in raw mode a PASTE arrives as a single chunk containing the whole key and
// its terminating carriage return, so a reader that switches on the chunk sees
// neither a character nor an Enter and hangs forever.

const ENTER = new Set(["\r", "\n", ""]); // CR, LF, Ctrl-D
const BACKSPACE = new Set(["", "\b"]);
const CTRL_C = "";

export function readSecret({ input = process.stdin, output = process.stdout, prompt = "Secret: " } = {}) {
  // No terminal means nothing to mask and nobody to prompt. Writing a prompt
  // into a pipe corrupts whatever is reading the other end.
  if (!input.isTTY) return readPipedLine(input);

  return new Promise((resolve, reject) => {
    let value = "";
    let done = false;

    const restore = () => {
      if (done) return;
      done = true;
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
    };

    const onData = (chunk) => {
      // Iterate the chunk, never switch on it: one chunk can be a whole
      // pasted key, and the last character of it is usually the Enter.
      for (const ch of String(chunk)) {
        if (ENTER.has(ch)) {
          restore();
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          restore();
          reject(new Error("cancelled — nothing was stored"));
          return;
        }
        if (BACKSPACE.has(ch)) {
          value = value.slice(0, -1);
          continue;
        }
        // Drop every other control character (arrow keys arrive as escape
        // sequences and would otherwise be spliced into the middle of a key).
        if (ch < " ") continue;
        value += ch;
      }
    };

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    input.on("data", onData);
  });
}

function readPipedLine(input) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      buffered += chunk;
    });
    input.on("end", () => resolve(buffered.split(/\r?\n/)[0]));
    input.on("error", reject);
    input.resume();
  });
}
