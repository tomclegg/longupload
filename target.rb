module Longupload::Target
  def longupload_cachefile
    x = '/tmp/longupload-cache'
    Dir.mkdir x unless File.directory? x
    x = "#{x}/#{self.class}_#{self.id}"
    Dir.mkdir x unless File.directory? x
    "#{x}/#{self.longupload_fingerprint}"
  end
end
