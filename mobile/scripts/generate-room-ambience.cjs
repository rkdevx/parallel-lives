const fs = require('node:fs');
const path = require('node:path');

const sampleRate = 16000;
const durationSeconds = 8;
const sampleCount = sampleRate * durationSeconds;
const fadeSamples = Math.round(sampleRate * 0.12);
const outputDirectory = path.join(__dirname, '..', 'assets', 'soundscapes');

const presets = [
  { id: 'room-tone', mode: 'tone' },
  { id: 'rain-on-glass', mode: 'rain' },
  { id: 'river-walk', mode: 'river' },
  { id: 'morning-birds', mode: 'birds' },
  { id: 'wind-in-leaves', mode: 'leaves' },
  { id: 'ocean-hush', mode: 'ocean' },
  { id: 'night-crickets', mode: 'crickets' },
  { id: 'cafe-window', mode: 'cafe' },
  { id: 'forest-dawn', mode: 'forest' },
  { id: 'soft-fireplace', mode: 'fire' },
];

function noiseAt(index, seed) {
  const value = Math.sin((index + seed * 8191) * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function chirp(time, start, duration, seed, amplitude = 1) {
  const elapsed = time - start;
  if (elapsed < 0 || elapsed > duration) return 0;
  const phase = elapsed / duration;
  const envelope = Math.sin(Math.PI * phase) ** 2;
  const frequency = 1500 + seed * 210 + phase * (900 + seed * 90);
  return Math.sin(2 * Math.PI * frequency * elapsed) * envelope * amplitude;
}

function sampleFor(mode, time, index, noise) {
  const slowWave = (Math.sin((2 * Math.PI * time) / durationSeconds) + 1) / 2;
  switch (mode) {
    case 'tone':
      return 0.24 * Math.sin(2 * Math.PI * 110 * time)
        + 0.14 * Math.sin(2 * Math.PI * 165 * time + 0.7)
        + 0.1 * Math.sin(2 * Math.PI * 220 * time + 1.1);
    case 'rain':
      return noise * (0.12 + 0.07 * slowWave) + 0.025 * Math.sin(2 * Math.PI * 62 * time);
    case 'river':
      return noise * 0.08 + Math.sin(2 * Math.PI * (75 + 13 * slowWave) * time) * 0.1
        + Math.sin(2 * Math.PI * 145 * time + 0.6) * 0.04;
    case 'birds':
      return noise * 0.025
        + chirp(time, 0.55, 0.2, 1, 0.22)
        + chirp(time, 0.88, 0.16, 2, 0.18)
        + chirp(time, 3.1, 0.23, 3, 0.19)
        + chirp(time, 3.48, 0.18, 1, 0.16)
        + chirp(time, 5.6, 0.2, 2, 0.2)
        + chirp(time, 6.02, 0.18, 3, 0.16);
    case 'leaves':
      return noise * (0.055 + 0.09 * slowWave) + Math.sin(2 * Math.PI * 54 * time) * 0.035;
    case 'ocean':
      return noise * (0.1 + 0.12 * slowWave) + Math.sin(2 * Math.PI * 48 * time) * (0.035 + 0.05 * slowWave);
    case 'crickets':
      return noise * 0.018
        + chirp(time, 0.4, 0.28, 4, 0.12)
        + chirp(time, 1.35, 0.28, 4, 0.12)
        + chirp(time, 2.3, 0.28, 4, 0.12)
        + chirp(time, 3.25, 0.28, 4, 0.12)
        + chirp(time, 4.2, 0.28, 4, 0.12)
        + chirp(time, 5.15, 0.28, 4, 0.12)
        + chirp(time, 6.1, 0.28, 4, 0.12)
        + chirp(time, 7.05, 0.28, 4, 0.12);
    case 'cafe':
      return noise * 0.045 + Math.sin(2 * Math.PI * 82 * time) * 0.07
        + Math.sin(2 * Math.PI * 123 * time + 1.2) * 0.03
        + chirp(time, 2.4, 0.035, 7, 0.045)
        + chirp(time, 6.35, 0.035, 6, 0.04);
    case 'forest':
      return noise * 0.045 + chirp(time, 0.8, 0.18, 2, 0.13)
        + chirp(time, 1.15, 0.2, 3, 0.12)
        + chirp(time, 4.4, 0.2, 1, 0.12)
        + chirp(time, 4.78, 0.17, 2, 0.13)
        + Math.sin(2 * Math.PI * 70 * time) * 0.035;
    case 'fire': {
      const crackle = noiseAt(index, 43) > 0.997 ? noiseAt(index, 8) * 0.12 : 0;
      return noise * 0.035 + Math.sin(2 * Math.PI * 58 * time) * 0.08 + crackle;
    }
    default:
      return 0;
  }
}

function writeWav(filename, samples) {
  const dataSize = samples.length * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples.length; index += 1) {
    wav.writeInt16LE(Math.round(samples[index] * 32767), 44 + index * 2);
  }
  fs.writeFileSync(filename, wav);
}

fs.mkdirSync(outputDirectory, { recursive: true });
for (const [presetIndex, preset] of presets.entries()) {
  const samples = new Float32Array(sampleCount);
  let filteredNoise = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const whiteNoise = noiseAt(index, presetIndex + 1);
    filteredNoise = filteredNoise * 0.88 + whiteNoise * 0.12;
    samples[index] = sampleFor(preset.mode, time, index, filteredNoise);
  }
  for (let offset = 0; offset < fadeSamples; offset += 1) {
    const blend = offset / fadeSamples;
    const tailIndex = sampleCount - fadeSamples + offset;
    samples[tailIndex] = samples[tailIndex] * (1 - blend) + samples[offset] * blend;
  }
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0.7 ? 0.7 / peak : 1;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.max(-0.7, Math.min(0.7, samples[index] * gain));
  }
  writeWav(path.join(outputDirectory, `${preset.id}.wav`), samples);
}
console.log(`Generated ${presets.length} original room soundscapes in ${outputDirectory}`);