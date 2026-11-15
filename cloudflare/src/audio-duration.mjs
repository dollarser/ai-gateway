// Structural duration scanners: no waveform decode and no trust in a duration tag.
// Unsupported/ambiguous containers return null so the bounded codec can take over.
function ascii(b, a, n) {
  return String.fromCharCode(...b.subarray(a, a + n));
}
function need(ok) {
  if (!ok) throw new Error("unsupported or damaged audio");
}
export function opusSamples(packet) {
  need(packet.length > 0);
  const config = packet[0] >> 3,
    code = packet[0] & 3;
  const frame =
    config < 12
      ? [480, 960, 1920, 2880][config & 3]
      : config < 16
        ? [480, 960][config & 1]
        : [120, 240, 480, 960][config & 3];
  let count =
    code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1] & 63 : 0;
  need(count > 0 && frame * count <= 5760);
  return frame * count;
}
function mp3(bytes) {
  let at = 0,
    end = bytes.length,
    frames = 0,
    ms = 0,
    signature = null;
  if (ascii(bytes, 0, 3) === "ID3") {
    need(
      bytes.length >= 10 &&
        [2, 3, 4].includes(bytes[3]) &&
        bytes.subarray(6, 10).every((n) => n < 128),
    );
    const size =
      (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    at = 10 + size + (bytes[3] === 4 && bytes[5] & 16 ? 10 : 0);
    need(at < end);
  }
  if (end >= 128 && ascii(bytes, end - 128, 3) === "TAG") end -= 128;
  while (at < end) {
    need(at + 4 <= end);
    const a = bytes[at],
      b = bytes[at + 1],
      c = bytes[at + 2];
    need(a === 255 && (b & 224) === 224);
    const version = (b >> 3) & 3,
      layer = (b >> 1) & 3,
      bitrate = c >> 4,
      sr = (c >> 2) & 3;
    need(version !== 1 && layer === 1 && bitrate > 0 && bitrate < 15 && sr < 3);
    const rate =
      [44100, 48000, 32000][sr] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const kbps = (
      version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    )[bitrate];
    const sig = version + ":" + rate;
    if (signature === null) signature = sig;
    need(signature === sig);
    const n =
      Math.floor(((version === 3 ? 144000 : 72000) * kbps) / rate) +
      ((c >> 1) & 1);
    need(n >= 8 && at + n <= end);
    ms += ((version === 3 ? 1152 : 576) * 1000) / rate;
    frames++;
    at += n;
  }
  need(frames >= 2 && at === end);
  return {
    milliseconds: Math.ceil(ms),
    format: "mp3",
    mime: "audio/mpeg",
    filename: "audio.mp3",
    method: "mpeg-frame-scan",
  };
}
function ogg(bytes) {
  let at = 0,
    serial = null,
    sequence = 0,
    pieces = [],
    pieceSize = 0,
    packetNo = 0,
    samples = 0,
    preSkip = 0,
    lastPacket = 0,
    finalGranule = null,
    ended = false;
  while (at < bytes.length) {
    need(
      !ended &&
        at + 27 <= bytes.length &&
        ascii(bytes, at, 4) === "OggS" &&
        bytes[at + 4] === 0,
    );
    const v = new DataView(bytes.buffer, bytes.byteOffset + at),
      flags = bytes[at + 5],
      sid = v.getUint32(14, true),
      seq = v.getUint32(18, true),
      count = bytes[at + 26];
    if (serial === null) {
      serial = sid;
      need(seq === 0 && flags & 2);
    }
    need(
      sid === serial &&
        seq === sequence++ &&
        at + 27 + count <= bytes.length &&
        Boolean(flags & 1) === pieceSize > 0,
    );
    let pos = at + 27 + count;
    for (let i = 0; i < count; i++) {
      const n = bytes[at + 27 + i];
      need(pos + n <= bytes.length);
      pieces.push(bytes.subarray(pos, pos + n));
      pieceSize += n;
      need(pieceSize <= 1048576);
      pos += n;
      if (n < 255) {
        const packet = new Uint8Array(pieceSize);
        let offset = 0;
        for (const part of pieces) {
          packet.set(part, offset);
          offset += part.length;
        }
        if (packetNo === 0) {
          need(
            packet.length >= 19 &&
              ascii(packet, 0, 8) === "OpusHead" &&
              packet[8] === 1 &&
              [1, 2].includes(packet[9]) &&
              packet[18] === 0,
          );
          preSkip = new DataView(packet.buffer).getUint16(10, true);
        } else if (packetNo === 1) need(ascii(packet, 0, 8) === "OpusTags");
        else {
          lastPacket = opusSamples(packet);
          samples += lastPacket;
        }
        packetNo++;
        pieces = [];
        pieceSize = 0;
      }
    }
    const granule = v.getBigUint64(6, true);
    if (granule !== 0xffffffffffffffffn) {
      need(granule <= BigInt(Number.MAX_SAFE_INTEGER));
      const g = Number(granule);
      if (packetNo > 2) {
        if (flags & 4) {
          need(g <= samples && g >= samples - lastPacket);
          finalGranule = g;
        } else need(g === samples);
      } else need(g === 0);
    }
    if (flags & 4) {
      need(pieceSize === 0);
      ended = true;
    }
    at = pos;
  }
  need(
    ended &&
      packetNo > 2 &&
      pieceSize === 0 &&
      finalGranule !== null &&
      finalGranule > preSkip,
  );
  return {
    milliseconds: Math.ceil((finalGranule - preSkip) / 48),
    format: "ogg-opus",
    mime: "audio/ogg",
    filename: "audio.ogg",
    method: "opus-packet-scan",
  };
}
function vint(b, at, id = false) {
  need(at < b.length);
  let n = 1,
    mask = 128;
  while (n <= 8 && !(b[at] & mask)) {
    n++;
    mask >>= 1;
  }
  need(n <= 8 && (!id || n <= 4) && at + n <= b.length);
  let value = id ? b[at] : b[at] & (mask - 1),
    unknown = !id && value === mask - 1;
  for (let i = 1; i < n; i++) {
    value = value * 256 + b[at + i];
    unknown = unknown && b[at + i] === 255;
  }
  need(Number.isSafeInteger(value) || unknown);
  return { n, value, unknown };
}
function webm(b) {
  let ticks = 1000000,
    track = null,
    codec = null,
    head = null,
    audioTracks = 0,
    otherTracks = 0,
    samples = 0,
    first = Infinity,
    last = 0,
    count = 0;
  const uint = (a, z) => {
    need(z - a <= 6);
    let n = 0;
    for (let i = a; i < z; i++) n = n * 256 + b[i];
    return n;
  };
  const element = (at, limit) => {
    need(++count < 500000);
    const id = vint(b, at, true),
      len = vint(b, at + id.n);
    const start = at + id.n + len.n,
      end = len.unknown ? limit : start + len.value;
    need(end <= limit && end >= start);
    return { id: id.value, start, end, unknown: len.unknown };
  };
  function blocks(a, z, time) {
    const t = vint(b, a);
    let at = a + t.n;
    need(at + 3 <= z);
    const relative = new DataView(b.buffer, b.byteOffset + at, 2).getInt16(
        0,
        false,
      ),
      flags = b[at + 2];
    at += 3;
    if (t.value !== track) return;
    const mode = (flags >> 1) & 3,
      lengths = [];
    let frames = 1;
    if (mode) {
      need(at < z);
      frames = b[at++] + 1;
      need(frames <= 256);
      if (mode === 2) {
        need((z - at) % frames === 0);
        for (let i = 0; i < frames - 1; i++) lengths.push((z - at) / frames);
      } else if (mode === 1) {
        for (let i = 0; i < frames - 1; i++) {
          let size = 0,
            n;
          do {
            need(at < z);
            n = b[at++];
            size += n;
          } while (n === 255);
          lengths.push(size);
        }
      } else {
        if (frames > 1) {
          let item = vint(b, at);
          need(!item.unknown);
          at += item.n;
          lengths.push(item.value);
          for (let i = 1; i < frames - 1; i++) {
            item = vint(b, at);
            need(!item.unknown);
            at += item.n;
            lengths.push(
              lengths[i - 1] + item.value - (2 ** (7 * item.n - 1) - 1),
            );
          }
        }
      }
    }
    const used = lengths.reduce((a, n) => a + n, 0);
    lengths.push(z - at - used);
    let packetSamples = 0;
    for (const n of lengths) {
      need(n > 0 && at + n <= z);
      packetSamples += opusSamples(b.subarray(at, at + n));
      at += n;
    }
    need(at === z);
    const ms = ((time + relative) * ticks) / 1000000;
    need(Number.isFinite(ms) && ms >= -1000);
    first = Math.min(first, ms);
    last = Math.max(last, ms + packetSamples / 48);
    samples += packetSamples;
  }
  function cluster(a, z) {
    let at = a,
      time = 0,
      haveTime = false;
    while (at < z) {
      const e = element(at, z);
      if (e.id === 0x1f43b675 || e.id === 0x1549a966 || e.id === 0x1654ae6b)
        return at;
      if (e.id === 0xe7) {
        time = uint(e.start, e.end);
        haveTime = true;
      } else if (e.id === 0xa3) {
        need(haveTime);
        blocks(e.start, e.end, time);
      } else if (e.id === 0xa0) {
        let p = e.start;
        while (p < e.end) {
          const x = element(p, e.end);
          if (x.id === 0xa1) {
            need(haveTime);
            blocks(x.start, x.end, time);
          }
          need(!x.unknown);
          p = x.end;
        }
      }
      need(!e.unknown);
      at = e.end;
    }
    return at;
  }
  let at = 0;
  const ebml = element(at, b.length);
  need(ebml.id === 0x1a45dfa3 && !ebml.unknown);
  at = ebml.end;
  const segment = element(at, b.length);
  need(segment.id === 0x18538067 && segment.end === b.length);
  at = segment.start;
  while (at < segment.end) {
    const e = element(at, segment.end);
    if (e.id === 0x1549a966) {
      let p = e.start;
      while (p < e.end) {
        const x = element(p, e.end);
        need(!x.unknown);
        if (x.id === 0x2ad7b1) ticks = uint(x.start, x.end);
        p = x.end;
      }
      need(ticks > 0 && ticks <= 1000000000);
    } else if (e.id === 0x1654ae6b) {
      let p = e.start;
      while (p < e.end) {
        const x = element(p, e.end);
        need(!x.unknown);
        if (x.id === 0xae) {
          let q = x.start,
            num = null,
            type = null,
            c = null,
            h = null;
          while (q < x.end) {
            const y = element(q, x.end);
            need(!y.unknown);
            if (y.id === 0xd7) num = uint(y.start, y.end);
            if (y.id === 0x83) type = uint(y.start, y.end);
            if (y.id === 0x86) c = ascii(b, y.start, y.end - y.start);
            if (y.id === 0x63a2) h = b.subarray(y.start, y.end);
            q = y.end;
          }
          if (type === 2) {
            audioTracks++;
            track = num;
            codec = c;
            head = h;
          } else otherTracks++;
        }
        p = x.end;
      }
    } else if (e.id === 0x1f43b675) {
      need(
        audioTracks === 1 &&
          otherTracks === 0 &&
          codec === "A_OPUS" &&
          head &&
          ascii(head, 0, 8) === "OpusHead",
      );
      at = cluster(e.start, e.end);
      continue;
    }
    need(!e.unknown);
    at = e.end;
  }
  need(
    samples > 0 && audioTracks === 1 && otherTracks === 0 && head.length >= 19,
  );
  const preSkip = new DataView(
    head.buffer,
    head.byteOffset,
    head.byteLength,
  ).getUint16(10, true);
  // Packet samples provide a conservative bound even if duration/timecode tags lie.
  const milliseconds = Math.ceil(
    Math.max((samples - preSkip) / 48, last - Math.max(0, first)),
  );
  need(milliseconds > 0);
  return {
    milliseconds,
    format: "webm-opus",
    mime: "audio/webm",
    filename: "audio.webm",
    method: "webm-opus-packet-scan",
  };
}
function mp4(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  function boxes(a, z) {
    const out = [];
    while (a < z) {
      need(a + 8 <= z);
      let n = v.getUint32(a),
        h = 8;
      if (n === 1) {
        need(a + 16 <= z);
        const big = v.getBigUint64(a + 8);
        need(big <= BigInt(Number.MAX_SAFE_INTEGER));
        n = Number(big);
        h = 16;
      }
      if (n === 0) n = z - a;
      need(n >= h && a + n <= z);
      out.push({ type: ascii(b, a + 4, 4), a: a + h, z: a + n, start: a });
      a += n;
      need(out.length < 500000);
    }
    return out;
  }
  const top = boxes(0, b.length);
  need(
    top.some((x) => x.type === "ftyp") && !top.some((x) => x.type === "moof"),
  );
  const moovs = top.filter((x) => x.type === "moov"),
    mdat = top.filter((x) => x.type === "mdat");
  need(moovs.length === 1 && mdat.length);
  const children = (x) => boxes(x.a, x.z),
    one = (list, type) => {
      const items = list.filter((x) => x.type === type);
      need(items.length === 1);
      return items[0];
    };
  const movie = children(moovs[0]),
    traks = movie.filter((x) => x.type === "trak");
  need(traks.length === 1);
  const scale = (x) => {
    need(x.a + 24 <= x.z);
    const n =
      b[x.a] === 0
        ? v.getUint32(x.a + 12)
        : b[x.a] === 1
          ? v.getUint32(x.a + 20)
          : 0;
    need(n > 0);
    return n;
  };
  const movieScale = scale(one(movie, "mvhd")),
    trak = children(traks[0]),
    media = children(one(trak, "mdia"));
  const handler = one(media, "hdlr");
  need(handler.a + 12 <= handler.z && ascii(b, handler.a + 8, 4) === "soun");
  const timeScale = scale(one(media, "mdhd")),
    table = children(one(children(one(media, "minf")), "stbl"));
  const desc = one(table, "stsd");
  need(desc.a + 8 <= desc.z && v.getUint32(desc.a + 4) === 1);
  const entries = boxes(desc.a + 8, desc.z);
  need(entries.length === 1 && entries[0].type === "mp4a");
  const entry = entries[0];
  need(entry.a + 28 <= entry.z && v.getUint16(entry.a + 8) === 0);
  const esds = one(boxes(entry.a + 28, entry.z), "esds");
  function descriptor(at, z, tag) {
    need(at < z && b[at++] === tag);
    let size = 0,
      n = 0,
      part;
    do {
      need(at < z && n++ < 4);
      part = b[at++];
      size = size * 128 + (part & 127);
    } while (part & 128);
    need(at + size <= z);
    return { a: at, z: at + size };
  }
  const es = descriptor(esds.a + 4, esds.z, 3);
  need(es.a + 3 <= es.z);
  const flags = b[es.a + 2];
  let at = es.a + 3;
  if (flags & 128) at += 2;
  if (flags & 64) {
    need(at < es.z);
    at += 1 + b[at];
  }
  if (flags & 32) at += 2;
  const config = descriptor(at, es.z, 4);
  need(config.a + 13 <= config.z && b[config.a] === 64);
  const asc = descriptor(config.a + 13, config.z, 5);
  need(asc.a + 2 <= asc.z);
  const object = b[asc.a] >> 3,
    index = ((b[asc.a] & 7) << 1) | (b[asc.a + 1] >> 7),
    channels = (b[asc.a + 1] >> 3) & 15;
  need(
    object === 2 &&
      index < 13 &&
      [1, 2].includes(channels) &&
      (b[asc.a + 1] & 7) === 0,
  );
  const rate = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ][index];
  need(timeScale === rate);
  const sizes = one(table, "stsz");
  need(sizes.a + 12 <= sizes.z);
  const fixed = v.getUint32(sizes.a + 4),
    count = v.getUint32(sizes.a + 8);
  need(
    count > 0 &&
      count < 500000 &&
      (fixed ? sizes.a + 12 === sizes.z : sizes.a + 12 + count * 4 === sizes.z),
  );
  const stts = one(table, "stts");
  need(stts.a + 8 <= stts.z);
  const nt = v.getUint32(stts.a + 4);
  need(stts.a + 8 + nt * 8 === stts.z);
  let samples = 0,
    duration = 0;
  for (let i = 0; i < nt; i++) {
    const n = v.getUint32(stts.a + 8 + i * 8),
      delta = v.getUint32(stts.a + 12 + i * 8);
    need(n > 0 && delta > 0);
    samples += n;
    duration += n * delta;
    need(Number.isSafeInteger(duration));
  }
  need(samples === count);
  const offsets = table.find((x) => x.type === "stco") ?? one(table, "co64");
  need(offsets.a + 8 <= offsets.z);
  const chunks = v.getUint32(offsets.a + 4),
    width = offsets.type === "stco" ? 4 : 8;
  need(
    chunks > 0 &&
      chunks <= count &&
      offsets.a + 8 + chunks * width === offsets.z,
  );
  const sc = one(table, "stsc");
  need(sc.a + 8 <= sc.z);
  const ns = v.getUint32(sc.a + 4);
  need(ns > 0 && sc.a + 8 + ns * 12 === sc.z);
  const map = [];
  for (let i = 0; i < ns; i++) {
    const a = sc.a + 8 + i * 12,
      first = v.getUint32(a),
      n = v.getUint32(a + 4);
    need(
      first > 0 &&
        first <= chunks &&
        n > 0 &&
        v.getUint32(a + 8) === 1 &&
        (!i ? first === 1 : first > map[i - 1].first),
    );
    map.push({ first, n });
  }
  let packet = 0,
    section = 0,
    lastEnd = 0;
  for (let chunk = 1; chunk <= chunks; chunk++) {
    while (section + 1 < map.length && map[section + 1].first <= chunk)
      section++;
    const at = offsets.a + 8 + (chunk - 1) * width;
    let start;
    if (width === 4) start = v.getUint32(at);
    else {
      const n = v.getBigUint64(at);
      need(n <= BigInt(Number.MAX_SAFE_INTEGER));
      start = Number(n);
    }
    need(start >= lastEnd);
    let size = 0;
    for (let i = 0; i < map[section].n; i++) {
      need(packet < count);
      const n = fixed || v.getUint32(sizes.a + 12 + packet * 4);
      need(n > 0 && n <= 1048576);
      size += n;
      packet++;
    }
    need(mdat.some((x) => start >= x.a && start + size <= x.z));
    lastEnd = start + size;
  }
  need(packet === count);
  const milliseconds = Math.ceil(
    (Math.max(count * 1024, duration) * 1000) / rate,
  );
  const edits = trak.find((x) => x.type === "edts");
  if (edits) {
    const list = one(children(edits), "elst");
    need(
      b[list.a] === 0 &&
        list.a + 20 === list.z &&
        v.getUint32(list.a + 4) === 1,
    );
    const length = v.getUint32(list.a + 8),
      skip = v.getInt32(list.a + 12);
    need(
      skip >= 0 &&
        v.getUint32(list.a + 16) === 65536 &&
        (length * 1000) / movieScale <= milliseconds + 2,
    );
  }
  return {
    milliseconds,
    format: "m4a-aac",
    mime: "audio/mp4",
    filename: "audio.m4a",
    method: "aac-sample-table-scan",
  };
}
export function compressedDuration(bytes) {
  try {
    let result = null;
    if (
      ascii(bytes, 0, 3) === "ID3" ||
      (bytes.length > 2 && bytes[0] === 255 && (bytes[1] & 224) === 224)
    )
      result = mp3(bytes);
    else if (ascii(bytes, 0, 4) === "OggS") result = ogg(bytes);
    else if (bytes.length > 12 && ascii(bytes, 4, 4) === "ftyp")
      result = mp4(bytes);
    else if (
      bytes.length >= 4 &&
      new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) === 0x1a45dfa3
    )
      result = webm(bytes);
    return result;
  } catch {
    return null;
  }
}
