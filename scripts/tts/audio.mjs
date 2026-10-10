import fs from 'node:fs';

export const normalizeToWav = async ({input, output, run, remotionCli}) => {
  try {
    await run(process.execPath, [remotionCli, 'ffmpeg', '-y', '-i', input, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output]);
  } finally {
    if (input !== output && fs.existsSync(input)) fs.rmSync(input, {force: true});
  }
};

export const writeAudioResponse = async ({response, output, run, remotionCli}) => {
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`TTS service returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const extension = contentType.includes('wav') ? 'wav' : contentType.includes('ogg') ? 'ogg' : 'mp3';
  const source = `${output}.source.${extension}`;
  fs.writeFileSync(source, Buffer.from(await response.arrayBuffer()));
  await normalizeToWav({input: source, output, run, remotionCli});
};
