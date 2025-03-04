/*
 * This code implements the MD5 message-digest algorithm.
 * The algorithm is due to Ron Rivest.  This code was
 * written by Colin Plumb in 1993, no copyright is claimed.
 * This code is in the public domain; do with it what you wish.
 *
 * The source code is located at https://fourmilab.ch/md5/. We also refer to the
 * open source modification part code of
 * bzflag[https://github.com/BZFlag-Dev/bzflag/blob/2.4/include/md5.h] to meet
 * the functional needs, which declares "Still in the public domain.".
 */

#ifndef DEBUGROUTER_NATIVE_PROTOCOL_MD5_H
#define DEBUGROUTER_NATIVE_PROTOCOL_MD5_H

/* system interface headers */
#include <iostream>
#include <string>

// a small class for calculating MD5 hashes of strings or byte arrays
// it is not meant to be fast or secure
//
// usage: 1) feed it blocks of uchars with update()
//  2) finalize()
//  3) get hexdigest() string
//      or
//  MD5(std::string).hexdigest()
//
// assumes that char is 8 bit and int is 32 bit
class MD5 {
 public:
  uint8_t digest[16];
  MD5();
  MD5(const std::string& text);
  void update(const unsigned char* buf, uint32_t length);
  void finalize();
  std::string hexdigest() const;
  friend std::ostream& operator<<(std::ostream&, MD5 md5);

 private:
  uint32_t buf[4];
  uint32_t bytes[2];
  uint32_t in[16];
  bool finalized;
  void init(void);
  void transform(void);
};

std::string md5(const std::string str);

#endif  // DEBUGROUTER_NATIVE_PROTOCOL_MD5_H
