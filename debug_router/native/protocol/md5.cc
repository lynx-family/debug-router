/*
 * This code implements the MD5 message-digest algorithm.
 * The algorithm is due to Ron Rivest.  This code was
 * written by Colin Plumb in 1993, no copyright is claimed.
 * This code is in the public domain; do with it what you wish.
 *
 * The source code is located at https://fourmilab.ch/md5/. We also refer to the
 * open source modification part code of
 * bzflag[https://github.com/BZFlag-Dev/bzflag/blob/2.4/src/common/md5.cxx] to
 * meet the functional needs, which declares "Still in the public domain.".
 */

#include "debug_router/native/protocol/md5.h"

/* for memcpy() */
#include <cstring>
/* for stupid systems */
#include <sys/types.h>

#ifdef WORDS_BIGENDIAN
void byteSwap(uint32_t *swbuf, unsigned words) {
  uint8_t *p = (uint8_t *)swbuf;

  do {
    *swbuf++ = (uint32_t)((unsigned)p[3] << 8 | p[2]) << 16 |
               ((unsigned)p[1] << 8 | p[0]);
    p += 4;
  } while (--words);
}
#else
#define byteSwap(swbuf, words)
#endif

// return hex representation of digest as string
std::string MD5::hexdigest() const {
  if (!finalized) return "";

  char txbuf[33];
  for (int i = 0; i < 16; i++) {
    snprintf(txbuf + i * 2, 33 - i * 2, "%02x", digest[i]);
  }
  txbuf[32] = 0;
  return std::string(txbuf);
}

/*
 * Start MD5 accumulation.  Set bit count to 0 and buffer to mysterious
 * initialization constants.
 */
void MD5::init() {
  finalized = false;
  buf[0] = 0x67452301;
  buf[1] = 0xefcdab89;
  buf[2] = 0x98badcfe;
  buf[3] = 0x10325476;

  bytes[0] = 0;
  bytes[1] = 0;
}

/*
 * Update context to reflect the concatenation of another buffer full
 * of bytes.
 */
void MD5::update(uint8_t const *inbuf, unsigned len) {
  uint32_t t;

  /* Update byte count */

  t = bytes[0];
  if ((bytes[0] = t + len) < t) bytes[1]++; /* Carry from low to high */

  t = 64 - (t & 0x3f); /* Space available in in (at least 1) */
  if (t > len) {
    memcpy((uint8_t *)in + 64 - t, inbuf, len);
    return;
  }
  /* First chunk is an odd size */
  memcpy((uint8_t *)in + 64 - t, inbuf, t);
  byteSwap(in, 16);
  MD5::transform();
  inbuf += t;
  len -= t;

  /* Process data in 64-byte chunks */
  while (len >= 64) {
    memcpy(in, inbuf, 64);
    byteSwap(in, 16);
    MD5::transform();
    inbuf += 64;
    len -= 64;
  }

  /* Handle any remaining bytes of data. */
  memcpy(in, inbuf, len);
}

/*
 * Final wrapup - pad to 64-byte boundary with the bit pattern
 * 1 0* (64-bit count of bits processed, MSB-first)
 */
void MD5::finalize() {
  /* Number of bytes in in */
  int count = bytes[0] & 0x3f;
  uint8_t *p = (uint8_t *)in + count;

  /* Set the first char of padding to 0x80.  There is always room. */
  *p++ = 0x80;

  /* Bytes of padding needed to make 56 bytes (-8..55) */
  count = 56 - 1 - count;

  if (count < 0) {
    /* Padding forces an extra block */
    memset(p, 0, count + 8);
    byteSwap(in, 16);
    MD5::transform();
    p = (uint8_t *)in;
    count = 56;
  }
  memset(p, 0, count);
  byteSwap(in, 14);

  /* Append length in bits and transform */
  in[14] = bytes[0] << 3;
  in[15] = bytes[1] << 3 | bytes[0] >> 29;
  MD5::transform();

  byteSwap(buf, 4);
  memcpy(digest, buf, 16);
  finalized = true;
}

// default ctor, just initailize
MD5::MD5() { init(); }

//////////////////////////////////////////////

// nifty shortcut ctor, compute MD5 for string and finalize it right away
MD5::MD5(const std::string &text) {
  init();
  MD5::update((uint8_t const *)text.c_str(), (unsigned int)text.length());
  finalize();
}

#ifndef ASM_MD5

/* The four core functions - F1 is optimized somewhat */

/* #define F1(x, y, z) (x & y | ~x & z) */
#define F1(x, y, z) (z ^ (x & (y ^ z)))
#define F2(x, y, z) F1(z, x, y)
#define F3(x, y, z) (x ^ y ^ z)
#define F4(x, y, z) (y ^ (x | ~z))

/* This is the central step in the MD5 algorithm. */
#define MD5STEP(f, w, x, y, z, in, s) \
  (w += f(x, y, z) + in, w = (w << s | w >> (32 - s)) + x)

/*
 * The core of the MD5 algorithm, this alters an existing MD5 hash to
 * reflect the addition of 16 longwords of new data.  MD5::update blocks
 * the data and converts bytes into longwords for this routine.
 */
void MD5::transform(void) {
  uint32_t a, b, c, d;

  a = buf[0];
  b = buf[1];
  c = buf[2];
  d = buf[3];

  MD5STEP(F1, a, b, c, d, in[0] + 0xd76aa478, 7);
  MD5STEP(F1, d, a, b, c, in[1] + 0xe8c7b756, 12);
  MD5STEP(F1, c, d, a, b, in[2] + 0x242070db, 17);
  MD5STEP(F1, b, c, d, a, in[3] + 0xc1bdceee, 22);
  MD5STEP(F1, a, b, c, d, in[4] + 0xf57c0faf, 7);
  MD5STEP(F1, d, a, b, c, in[5] + 0x4787c62a, 12);
  MD5STEP(F1, c, d, a, b, in[6] + 0xa8304613, 17);
  MD5STEP(F1, b, c, d, a, in[7] + 0xfd469501, 22);
  MD5STEP(F1, a, b, c, d, in[8] + 0x698098d8, 7);
  MD5STEP(F1, d, a, b, c, in[9] + 0x8b44f7af, 12);
  MD5STEP(F1, c, d, a, b, in[10] + 0xffff5bb1, 17);
  MD5STEP(F1, b, c, d, a, in[11] + 0x895cd7be, 22);
  MD5STEP(F1, a, b, c, d, in[12] + 0x6b901122, 7);
  MD5STEP(F1, d, a, b, c, in[13] + 0xfd987193, 12);
  MD5STEP(F1, c, d, a, b, in[14] + 0xa679438e, 17);
  MD5STEP(F1, b, c, d, a, in[15] + 0x49b40821, 22);

  MD5STEP(F2, a, b, c, d, in[1] + 0xf61e2562, 5);
  MD5STEP(F2, d, a, b, c, in[6] + 0xc040b340, 9);
  MD5STEP(F2, c, d, a, b, in[11] + 0x265e5a51, 14);
  MD5STEP(F2, b, c, d, a, in[0] + 0xe9b6c7aa, 20);
  MD5STEP(F2, a, b, c, d, in[5] + 0xd62f105d, 5);
  MD5STEP(F2, d, a, b, c, in[10] + 0x02441453, 9);
  MD5STEP(F2, c, d, a, b, in[15] + 0xd8a1e681, 14);
  MD5STEP(F2, b, c, d, a, in[4] + 0xe7d3fbc8, 20);
  MD5STEP(F2, a, b, c, d, in[9] + 0x21e1cde6, 5);
  MD5STEP(F2, d, a, b, c, in[14] + 0xc33707d6, 9);
  MD5STEP(F2, c, d, a, b, in[3] + 0xf4d50d87, 14);
  MD5STEP(F2, b, c, d, a, in[8] + 0x455a14ed, 20);
  MD5STEP(F2, a, b, c, d, in[13] + 0xa9e3e905, 5);
  MD5STEP(F2, d, a, b, c, in[2] + 0xfcefa3f8, 9);
  MD5STEP(F2, c, d, a, b, in[7] + 0x676f02d9, 14);
  MD5STEP(F2, b, c, d, a, in[12] + 0x8d2a4c8a, 20);

  MD5STEP(F3, a, b, c, d, in[5] + 0xfffa3942, 4);
  MD5STEP(F3, d, a, b, c, in[8] + 0x8771f681, 11);
  MD5STEP(F3, c, d, a, b, in[11] + 0x6d9d6122, 16);
  MD5STEP(F3, b, c, d, a, in[14] + 0xfde5380c, 23);
  MD5STEP(F3, a, b, c, d, in[1] + 0xa4beea44, 4);
  MD5STEP(F3, d, a, b, c, in[4] + 0x4bdecfa9, 11);
  MD5STEP(F3, c, d, a, b, in[7] + 0xf6bb4b60, 16);
  MD5STEP(F3, b, c, d, a, in[10] + 0xbebfbc70, 23);
  MD5STEP(F3, a, b, c, d, in[13] + 0x289b7ec6, 4);
  MD5STEP(F3, d, a, b, c, in[0] + 0xeaa127fa, 11);
  MD5STEP(F3, c, d, a, b, in[3] + 0xd4ef3085, 16);
  MD5STEP(F3, b, c, d, a, in[6] + 0x04881d05, 23);
  MD5STEP(F3, a, b, c, d, in[9] + 0xd9d4d039, 4);
  MD5STEP(F3, d, a, b, c, in[12] + 0xe6db99e5, 11);
  MD5STEP(F3, c, d, a, b, in[15] + 0x1fa27cf8, 16);
  MD5STEP(F3, b, c, d, a, in[2] + 0xc4ac5665, 23);

  MD5STEP(F4, a, b, c, d, in[0] + 0xf4292244, 6);
  MD5STEP(F4, d, a, b, c, in[7] + 0x432aff97, 10);
  MD5STEP(F4, c, d, a, b, in[14] + 0xab9423a7, 15);
  MD5STEP(F4, b, c, d, a, in[5] + 0xfc93a039, 21);
  MD5STEP(F4, a, b, c, d, in[12] + 0x655b59c3, 6);
  MD5STEP(F4, d, a, b, c, in[3] + 0x8f0ccc92, 10);
  MD5STEP(F4, c, d, a, b, in[10] + 0xffeff47d, 15);
  MD5STEP(F4, b, c, d, a, in[1] + 0x85845dd1, 21);
  MD5STEP(F4, a, b, c, d, in[8] + 0x6fa87e4f, 6);
  MD5STEP(F4, d, a, b, c, in[15] + 0xfe2ce6e0, 10);
  MD5STEP(F4, c, d, a, b, in[6] + 0xa3014314, 15);
  MD5STEP(F4, b, c, d, a, in[13] + 0x4e0811a1, 21);
  MD5STEP(F4, a, b, c, d, in[4] + 0xf7537e82, 6);
  MD5STEP(F4, d, a, b, c, in[11] + 0xbd3af235, 10);
  MD5STEP(F4, c, d, a, b, in[2] + 0x2ad7d2bb, 15);
  MD5STEP(F4, b, c, d, a, in[9] + 0xeb86d391, 21);

  buf[0] += a;
  buf[1] += b;
  buf[2] += c;
  buf[3] += d;
}

//////////////////////////////
std::string md5(const std::string str) {
  MD5 md5 = MD5(str);
  return md5.hexdigest();
}

#endif
