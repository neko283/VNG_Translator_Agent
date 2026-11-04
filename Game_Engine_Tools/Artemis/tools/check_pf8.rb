#!/usr/bin/env ruby
# Independent read-only audit: standard Ruby Digest, no import of pf8.py.
# Usage: ruby check_pf8.rb archive.pfs extracted-resource-root
require 'digest'
require 'json'
archive, root = ARGV
abort 'Usage: check_pf8.rb archive resource-root' unless archive && root
bytes = File.binread(archive)
raise 'Not PF8' unless bytes[0, 3] == 'pf8'
index_size = bytes[3, 4].unpack1('V')
index = bytes[7, index_size]
key = Digest::SHA1.digest(index).bytes
count = index[0, 4].unpack1('V')
position = 4
footer_positions = []
count.times do
  length = index[position, 4].unpack1('V'); position += 4
  name = index[position, length].force_encoding('Windows-31J').encode('UTF-8').tr('\\', '/')
  position += length
  footer_positions << position
  reserved, offset, size = index[position, 12].unpack('V3'); position += 12
  raise 'Unsafe path' if name.start_with?('/') || name.split('/').any? { |s| s == '..' || s == '.' || s.include?(':') }
  raise 'Out of bounds' if offset < 7 + index_size || offset + size > bytes.bytesize
  # The current test packages contain only encrypted entries.
  decoded = bytes[offset, size].bytes.each_with_index.map { |b, i| b ^ key[i % 20] }.pack('C*')
  expected = File.binread(File.join(root, name))
  raise "Resource differs: #{name}" unless decoded == expected
end
footer_start = position
raise 'Footer count mismatch' unless index[position, 4].unpack1('V') == count + 1
position += 4
actual_offsets = index[position, (count + 1) * 8].unpack('Q<*')
raise 'Footer offsets mismatch' unless actual_offsets == footer_positions + [0]
position += (count + 1) * 8
raise 'Footer pointer mismatch' unless index[position, 4].unpack1('V') == footer_start
raise 'Extra index bytes' unless position + 4 == index_size
puts JSON.generate(archive: archive, resources: count, resource_bytes_equal: true, footer_verified: true, sha256: Digest::SHA256.hexdigest(bytes))
