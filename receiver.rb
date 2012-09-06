module Longupload::Receiver

  WAREHOUSE_BLOCK_SIZE = 2**26

  def longupload
    @longupload_max_databytes = 2**24
    @longupload_max_databytes = LONGUPLOAD_MAX_DATABYTES if defined? LONGUPLOAD_MAX_DATABYTES
    @response = {}
    @ds = nil
    begin
      if request.env.has_key?('HTTP_X_UPLOAD_ID') then
        handle_upload_piece
      elsif params.has_key?('file_quicksig') then
        handle_upload_start
      else
        return false
      end
    rescue Exception => e
      @response['success'] = false
      @response['error'] = e.message
      logger.debug e.message
      logger.debug e.backtrace.join("\n")
    end
    logger.debug @response.to_json
    render :json => @response
  end

  private

  def handle_upload_start
    raise 'You need to be logged in to upload' if not current_user
    @fingerprint = Digest::MD5.hexdigest(params[:file_quicksig])
    @response['max_databytes'] = @longupload_max_databytes
    @response['success'] = false
    start_or_resume_file(params[:file_quicksig])
    logger.info "upload_start: #{@ds.longupload_cachefile} #{@response.inspect}"
  end

  def start_or_resume_file(file_quicksig)
    @timestamp = Time.now.to_i
    @filesize_stored = 0
    @filesize_client = -1
    @md = file_quicksig.match(/^(\d+),/)
    if not @md.nil? then
      @filesize_client = @md[1].to_i
    end

    @target_spec = params[:longupload_target].
      merge(:user => current_user,
            :longupload_fingerprint => @fingerprint,
            :longupload_file_name => params[:file_name],
            :longupload_size => @filesize_client)
    @ds = longupload_target_class.find_all_by_longupload_info(@target_spec).first
    if !@ds
      @ds = longupload_target_class.new(@target_spec)
      @ds.longupload_bytes_received = 0
      unless @ds.save
        # fixme: should send @ds.errors back through to rails client side
        raise "#{@ds.errors.full_messages.join '; '}"
      end
    end
    @response['upload_id'] = @ds.longupload_id

    # Can we write to @cachefile?
    @cachefile = @ds.longupload_cachefile
    raise 'Could not create/update cache file' if !FileUtils.touch("#{@cachefile}.filename.#{@timestamp}")

    # Store the filename as specified by the uploader
    @fh = File.new("#{@cachefile}.filename.#{@timestamp}", "w")
    @fh.write(params[:file_name])
    @fh.close

    # Maybe the Dataset object knows that it is complete
    @i = -1
    while true do
      @i += 1
      if File.exists?("#{@cachefile}.todo.#{@i}") and
          (@block_size = File.size("#{@cachefile}.todo.#{@i}")) then
        # stored on disk, not in warehouse yet
        @filesize_stored += @block_size
        next if @block_size == WAREHOUSE_BLOCK_SIZE
      elsif ((@ds.warehouse_blocks and (@locator = @ds.warehouse_blocks[@i])) or
             (File.symlink?("#{@cachefile}.block.#{@i}") and
              (@locator = File.readlink("#{@cachefile}.block.#{@i}")))
             ) then
        if (@md = @locator.match(/\+GS(\d+)/)) or
            (@md = @locator.match(/\+(\d+)/)) then
          @filesize_stored += @md[1].to_i
          next
        elsif (@ds.warehouse_blocks and @ds.warehouse_blocks[@i+1]) or
            File.symlink?("#{@cachefile}.block.#{@i+1}") then
          # we've already stored this and the next block in the
          # warehouse
          @filesize_stored += WAREHOUSE_BLOCK_SIZE
          next
        else
          # Something has been stored in the warehouse, but we can't
          # figure out the stored data size.  Resume from the
          # beginning of this block.
        end
      end
      # If there was no "next" statement by now, we need to resume
      # from @filesize_stored.
      break
    end
    # Truncate at the end of the last complete block
    @ds.longupload_bytes_received = @filesize_stored
    @ds.save!
    if @ds.longupload_bytes_received == @ds.longupload_size then
      @ds.after_longupload_block(@i)
      @ds.after_longupload_file
      @response['complete'] = true
    else
      @response['complete'] = false
    end
    @response['resume_from'] = @filesize_stored
    @response['success'] = true
  end

  def handle_upload_piece
    @response['success'] = false
    @response['upload_id'] = sanitize(request.env['HTTP_X_UPLOAD_ID'])
    @response['upload_size'] = sanitize(request.env['HTTP_X_UPLOAD_SIZE']).to_i
    @response['piece_quicksig'] = sanitize(request.env['HTTP_X_PIECE_QUICKSIG'])
    @response['piece_position'] = sanitize(request.env['HTTP_X_PIECE_POSITION']).to_i
    @response['piece_size'] = sanitize(request.env['HTTP_X_PIECE_SIZE']).to_i
    @data = request.raw_post()
    @response['piece_quicksig_received'] = quicksig(@data)
    @response['piece_size_recieved'] = @data.size
    raise 'Received size mismatch' if @response['piece_size_recieved'].to_i != @response['piece_size'].to_i
    raise 'Received quicksig mismatch' if @response['piece_quicksig_received'] != @response['piece_quicksig']
    @ds = longupload_target_class.find_all_by_longupload_info(:user => current_user, :longupload_id => @response['upload_id']).first
    store_piece(@data)
    logger.info "upload_piece: #{@ds.longupload_cachefile} #{@response.inspect}"
  end

  def store_piece(data)
    @cachefile = @ds.longupload_cachefile
    @blockindex = (@response['piece_position'] / WAREHOUSE_BLOCK_SIZE).floor
    raise "Resume error" if (@blockindex * WAREHOUSE_BLOCK_SIZE != @response['piece_position']) and not File.exists?("#{@cachefile}.todo.#{@blockindex}")
    @writepos = @response['piece_position'] - @blockindex * WAREHOUSE_BLOCK_SIZE
    # See if this block will take us over the edge of WAREHOUSE_BLOCK_SIZE
    @next_bytes_to_write = 0
    @bytes_to_write = data.size
    @data_to_write = data
    if ((@bytes_to_write + @writepos) > WAREHOUSE_BLOCK_SIZE) then
      @bytes_to_write = WAREHOUSE_BLOCK_SIZE - @writepos
      @data_to_write = data[0,@bytes_to_write]
      @next_bytes_to_write = data.size - @bytes_to_write
      @next_data_to_write = data[@bytes_to_write,data.size]
    end

    # create the file if necessary (but don't truncate)
    @fh = File.open("#{@cachefile}.todo.#{@blockindex}","a+")
    @fh.close

    # re-open the file with a mode that supports seek+write
    @fh = File.open("#{@cachefile}.todo.#{@blockindex}","r+")
    @fh.flock(File::LOCK_EX)
    @fh.seek(@writepos, IO::SEEK_SET)
    raise "Unable to seek to correct position in file" if @fh.pos != @writepos
    @fh.write(@data_to_write)
    raise "Write error: #{@fh.pos} != #{@writepos + @data_to_write.size}" if @fh.pos != @writepos + @data_to_write.size
    @fh.close
    # Did we roll over to a new file?
    if (@next_bytes_to_write > 0) then
      # Give someone a chance to copy this to the warehouse, or queue
      # a job to do so.
      @ds.after_longupload_block(@blockindex)

      # Then write the rest of the data
      @blockindex += 1
      @fh = File.open("#{@cachefile}.todo.#{@blockindex}","w")
      @fh.write(@next_data_to_write)
      raise "Write error" if @fh.pos != @next_data_to_write.size
      @fh.close
    end
    @response['piece_size_received'] = @response['piece_size']
    @response['success'] = true

    new_bytes_received = @response['piece_size'] + @response['piece_position']

    if new_bytes_received == @response['upload_size'] or
        new_bytes_received == @blockindex * WAREHOUSE_BLOCK_SIZE then
      @ds.after_longupload_block(@blockindex)
    end
    if (new_bytes_received == @response['upload_size']) then
      # Tell the application all the data has arrived
      @ds.after_longupload_file
      # Tell the client that its job is finished
      @response['complete'] = true
    end

    while @ds.longupload_bytes_received < new_bytes_received
      begin
        @ds.longupload_bytes_received = new_bytes_received
        @ds.save!
      rescue ActiveRecord::StaleObjectError
        @ds.reload
      end
    end
  end

  def quicksig(s)
    @parts = '';
    @i = 0
    while @i < s.size
      @parts += s.slice(@i, 256)
      @i += 524288
    end
    return Digest::MD5.hexdigest(@parts)
  end

  def sanitize(s)
    s.gsub(/[^0-9a-fA-F]/,'')
  end
end
