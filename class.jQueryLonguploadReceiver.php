<? ; // -*- mode: java; c-basic-offset: 2; tab-width: 4; -*-
//
// Copyright 2011 Clinical Future, Inc.

class jQueryLonguploadReceiver {

  protected $response = array();
  const quicksig_frag_size = 256;

  // Override this function in order to prevent collisions between
  // similar/identical files uploaded by different users.  The string
  // returned by this function will be prepended to cache files.
  // Therefore, it should return a string which:
  // 
  // * Is unique for this user (not session; otherwise "resume" will break)
  // * Contains only filename-safe characters, e.g., [a-zA-Z0-9]

  function get_user_prefix() {
	return '';
  }

  function get_cachedir() {
	return './longupload-cache';
  }

  function hook_piece_written($is_last_piece) {
	// Do stuff after a piece of a file has been received and written
	// to disk.
  }

  function get_cachefile($upload_id) {
	if (!is_writable($this->get_cachedir().'/.'))
	  $this->error_out ('server setup problem: cache directory is unwritable');
	$user_prefix = $this->get_user_prefix();
	$cachedir = $this->get_cachedir();
	return "$cachedir/$user_prefix$upload_id";
  }

  // Override the next two functions in order to use a different
  // method for storing file data as it is received.

  function start_or_resume_file($file_quicksig, &$params) {
	$upload_id = $this->response['upload_id'];
	$cachefile = $this->get_cachefile($upload_id);
	$complete = false;
	$resume_from = 0;
	if (!touch($cachefile))
	  $this->error_out ('could not create/update cache file', true);
	$timestamp = time();
	file_put_contents("$cachefile.filename.$timestamp", @$params['file_name']);
	if (file_exists($cachefile)) {
	  $filesize = filesize ($cachefile);
	  $filesize_verified = 0;
	  $ok = false;
	  $fh = fopen ($cachefile, 'r');
	  foreach (explode (',', $file_quicksig) as $qs) {
		if (preg_match ('/^\d+$/', $qs)) {
		  $filesize_client = $this->response['upload_size'] = $qs;
		  continue;
		}
		list ($pos, $len, $md5) = explode ('-', $qs);
		if ($len && $md5) {
		  $ok = false;
		  if ($pos + $len > $filesize)
			break;
		  fseek ($fh, +$pos, SEEK_SET);
		  if (ftell($fh) != +$pos)
			break;
		  $buf = fread ($fh, $len);
		  if ($md5 != md5($buf))
			break;
		  $filesize_verified = $pos;
		  $ok = true;
		}
	  }
	  fclose($fh);
	  if ($ok && $filesize_client > 0 && $filesize == $filesize_client) {
		$complete = true;
		$resume_from = $filesize;
	  }
	  else
		$resume_from = $filesize_verified;
	}
	$this->response['complete'] = $complete;
	$this->response['resume_from'] = +$resume_from;
	$this->response['success'] = true;
  }

  function store_piece (&$piece_data) {
	$cachefile = $this->get_cachefile($this->response['upload_id']);

	if (version_compare(PHP_VERSION, '5.2.6') >= 0)
	  $fh = @fopen ($cachefile, 'c');
	else {
	  if (($fh = @fopen ($cachefile, 'x')))
		fclose($fh);
	  $fh = @fopen ($cachefile, 'r+');
	}
	if (!$fh)
	  $this->error_out ('could not open file on server', true);

	fseek ($fh, +$this->response['piece_position'], SEEK_SET);
	if (ftell($fh) != +$this->response['piece_position'])
	  $this->error_out ("could not seek to {$this->response['piece_position']}", true);

	$wrote = fwrite ($fh, $piece_data);
	if ($wrote != $this->response['piece_size'])
	  $this->error_out ('server write failed', true);

	if (!fclose ($fh))
	  $this->error_out ('server close failed', true);

	$this->response['success'] = true;
	$this->response['piece_size_received'] = $wrote;

	$this->hook_piece_written($this->response['piece_position'] + $wrote ==
							  $this->response['upload_size']);
  }

  // Remove naughty characters from the given string.

  static function sanitize (&$s)
  {
    $s = preg_replace ('/[^0-9a-f]/i', '', $s);
  }

  // Compute a signature by hashing a few small parts of a string.
  // This *has* to agree with the function on the client side, or
  // uploading won't work.

  function quicksig (&$s)
  {
    $sigparts = '';
    for ($i=0; $i<strlen($s); $i+=524288)
	  $sigparts .= substr($s, $i, self::quicksig_frag_size);
    return md5($sigparts);
  }

  function max_databytes() {
	$max = 67108864;
	foreach (explode(' ','memory_limit post_max_size') as $ini) {
	  $x = preg_replace ('/M/', '000000', ini_get($ini));
	  if (preg_match('/^memory/', $ini)) $x = $x / 4;
	  if ($x < $max)
		$max = $x;
	}
	return $max;
  }

  function error_out ($message, $use_php_errormsg=false)
  {
    global $php_errormsg;
    if ($use_php_errormsg &&
		preg_match ('/.*: (.*)/', $php_errormsg, $regs))
	  $message .= strtolower(": $regs[1]");
    $this->response['error'] = $message;
	$this->response['success'] = false;
    print json_encode ($this->response);
    error_log ($this->response["upload_id"] . ": " . $message);
    exit;
  }

  function handle_upload_start($file_quicksig, &$params) {
	$upload_id = md5($file_quicksig);
	$this->response['upload_id'] = $upload_id;
	$this->response['max_databytes'] = $this->max_databytes();
	$this->response['success'] = false;
	$this->start_or_resume_file ($file_quicksig, $params);
  }

  function handle_upload_piece() {
	$upload_id = $_SERVER['HTTP_X_UPLOAD_ID'];
	$upload_size = $_SERVER['HTTP_X_UPLOAD_SIZE'];
	$piece_quicksig = $_SERVER['HTTP_X_PIECE_QUICKSIG'];
	$piece_position = $_SERVER['HTTP_X_PIECE_POSITION'];
	$piece_size = $_SERVER['HTTP_X_PIECE_SIZE'];
	self::sanitize ($upload_id);
	self::sanitize ($piece_quicksig);
	self::sanitize ($piece_position);
	self::sanitize ($piece_size);

	$piece_data = file_get_contents ('php://input');

	$this->response = array
	  ('upload_id' => $upload_id,
	   'upload_size' => $upload_size,
	   'piece_quicksig' => $piece_quicksig,
	   'piece_quicksig_received' => $this->quicksig($piece_data),
	   'piece_position' => $piece_position,
	   'piece_size' => $piece_size,
	   'piece_size_received' => strlen($piece_data),
	   'success' => false);

	if ($this->response['piece_size_received'] != +$piece_size)
	  $this->error_out ('incomplete transfer');
	if ($this->response['piece_quicksig_received'] !== $piece_quicksig)
	  $this->error_out ('checksum mismatch');

	$this->store_piece ($piece_data);
  }

  function handle_post() {
	// Typical usage:
	// 
	// if($receiver->handle_post()) exit;

	ini_set ('track_errors', true);
	if (isset($_SERVER['HTTP_X_UPLOAD_ID']))
	  $this->handle_upload_piece();
	else if (isset($_POST['file_quicksig']))
	  $this->handle_upload_start($_POST['file_quicksig'], $_POST);
	else
	  return false;				// evidently this request was not meant for us
	print json_encode ($this->response);
	return true;
  }
}
