// -*- mode: java; c-basic-offset: 2; tab-width: 4; indent-tabs-mode: nil; -*-
//
// Copyright 2011 Clinical Future, Inc.

(function($){

  var methods = {
    'init': init,
    'go': go,
    'stop': stop,
    'option': option
  };

  $.fn.longupload = function(method) {
    if (methods[method])
      return methods[method].apply(this, Array.prototype.slice.call(arguments,1));
    else if (typeof method === 'object' || !method)
      return methods.init.apply(this, arguments);
    else
      $.error('Method '+method+' does not exist in jQuery.longupload');
  };

  $.fn.longupload.defaults = {
    'sUploadHandlerURI': 'jquery.longupload.server.php',
    'bAutoProgressBar': true,
    'bQuicksigSize': 256,
    'fScanChunkSize': scan_chunk_size
  };

  var compatibility_check = false;

  function option (key, val) {
	this.data('longupload').opts[key] = val;
  }

  function init (opts_create) {

    if (!compatibility_check) {
      compatibility_check = true;
      if (!(window.File &&
			window.FileReader &&
			window.FileList &&
			window.Blob)) {
		alert('The File APIs are not fully supported in this browser.');
      } else if (!rstr_md5 || !rstr2hex) {
		alert('Installation problem: need rstr_md5() and rstr2hex()');
      }
    }

    var opts_all = $.extend({}, $.fn.longupload.defaults, opts_create);

    return this.each(function(){
		var opts = $.meta ? $.extend({}, opts_all, $(this).data()) : opts_all;
		var data = { 'opts': opts, 'input': this, 'jobs': [] };
		$(this).data('longupload', data);
      });
  }

  function scan_chunk_size(filesize) {
    var chunksize = 4*1024*1024;
    while (chunksize > 1024*1024 && filesize / chunksize < 32)
      chunksize = chunksize / 2;
    while (chunksize < 1024*1024*1024 && filesize / chunksize > 512)
      chunksize = chunksize * 2;
    return chunksize;
  }
  function quicksig(s, quicksig_size) {
    var sigparts = '';
    for (var i=0; i<s.length; i+=524288)
      sigparts += s.slice(i, Math.min(s.length, i+quicksig_size));
    return rstr2hex(rstr_md5(sigparts));
  }
  function Job(opts) {
    $.extend(this, opts);
  }
  Job.prototype.onprogress = function() {
    if (this.state == 'finished') return;
    $(this.domTarget).trigger($.Event('longupload-progress'),
							  [this, { 'state': this.state,
									'speed': this.current_speed,
									'position': this.current_pos,
									'size': this.file.size }]);
  }
  Job.prototype.onsuccess = function() {
    $(this.domTarget).trigger($.Event('longupload-success'),
							  [this, { 'speed': this.current_speed,
									   'size': this.file.size }]);
  }
  Job.prototype.onfailure = function() {
    $(this.domTarget).trigger($.Event('longupload-failure'),
							  [this, { 'speed': this.current_speed,
									   'size': this.file.size,
									   'error': this.error }]);
  }
  Job.prototype.abort = function() {
    if (this.state == 'finished') return;

    // if I haven't started yet, remove myself from my queue and
    // delete my progressbar
    var q = this.queueTarget.queue('longupload');
    for (i=0; q[i]; i++)
      if (q[i].job == this) {
		q.splice(i,1);
		--i;
		if (this.progressbar_row)
		  $(this.progressbar_row).remove();
      }
    this.queueTarget.queue('longupload', q); // unnecessary? docs unclear

    // stop operations in progress, if any
    this.reader.ready = false;
    this.read_in_progress = false;
    var was_in_progress = this.upload_in_progress;
    this.upload_in_progress = false;
    if (was_in_progress) {
      was_in_progress.writer.abort = true;
      was_in_progress.writer.xhr.abort();
    }
    $(this.domTarget).trigger($.Event('longupload-abort'),
							  [this, { 'size': this.file.size }]);
  }
  function humanBytes(x) {
    var u = 'B';
    var places = 0;
    if (x > 10000) { u = 'KB'; x = x / 1000; }
    if (x > 10000) { u = 'MB'; x = x / 1000; }
    if (x > 10000) { u = 'GB'; x = x / 1000; places = 2; }
    x = ""+x.toFixed(places);
    return x+' '+u;
  }
  Job.prototype.get_file = function() {
	return this.file;
  }
  Job.prototype.get_upload_id = function() {
	return this.server_says.upload_id;
  }
  Job.prototype.handle_server_response_to_upload_start = function(response) {
    this.state = 'upload';
    this.server_says = response;
	if (!this.server_says.success) {
	  this.error = this.server_says.error;
	  this.onfailure();
	  return;
	}
    this.bufsize = 65536;
    this.elapsed = 0;
    this.reader.start = 0;
    if (response.resume_from > 0)
      this.reader.start = response.resume_from;
    if (response.complete)
      this.reader.start = this.file.size;
    this.uploadStartTime = (new Date()).getTime();
    this.uploadStartByte = this.reader.start;
    this.current_speed = false;
    this.current_position = this.reader.start;
    this.read_current_slice();
  }
  Job.prototype.read_current_slice = function() {
    if (this.reader.start >= this.file.size) {
      this.read_in_progress = true;
      this.reader.ready = true;
      if (!this.upload_in_progress)
        this.filereader_onload();
      return;
    }
    this.reader.databytes = this.state=='scan' ?
	this.ludata.opts.bQuicksigSize : this.bufsize;
    this.reader.databytes = Math.min(this.reader.databytes,
									 this.file.size - this.reader.start);
    if (this.file.slice)
      this.reader.blob = this.file.slice(this.reader.start, this.reader.databytes,
                                         'application/octet-stream; charset=x-user-defined');
    else if (this.file.mozSlice)
      this.reader.blob = this.file.mozSlice(this.reader.start, this.reader.databytes,
                                            'application/octet-stream; charset=x-user-defined');
    else if (this.file.webkitSlice)
      this.reader.blob = this.file.webkitSlice(this.reader.start, this.reader.databytes,
                                               'application/octet-stream; charset=x-user-defined');
    delete this.filereader;
    this.filereader = new FileReader();
    var thisjob = this;
    this.filereader.onload = function(){ thisjob.filereader_onload() };
    this.filereader.onerror = function(){ thisjob.filereader_onerror() };
    this.filereader.readAsBinaryString(this.reader.blob);
    this.read_in_progress = this.filereader;
  }
  Job.prototype.send_chunk_to_server = function() {
    var xhr = new XMLHttpRequest;
    this.upload_in_progress = this;
    this.writer.xhr = xhr;
    this.current_pos = this.writer.start;
    this.onprogress();
    xhr.open('POST', this.ludata.opts.sUploadHandlerURI, true);
    var thisjob = this;
    xhr.upload.onprogress = function(e) {
      thisjob.current_pos = thisjob.writer.start + e.loaded;
      thisjob.onprogress();
    };
    xhr.onreadystatechange = function() {
      thisjob.writer_onload(xhr);
    };
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Upload-Id", this.server_says.upload_id);
    xhr.setRequestHeader("X-Upload-Size", this.file.size);
    xhr.setRequestHeader("X-Piece-Quicksig", this.writer.quicksig);
    xhr.setRequestHeader("X-Piece-Position", this.writer.start);
    xhr.setRequestHeader("X-Piece-Size", this.writer.blob.size);
    xhr.send(this.writer.blob);
  }
  Job.prototype.writer_onload = function(xhr) {
    if (this.writer.abort)
      return;
    if (xhr.readyState === 4) {
      if (!this.upload_in_progress) return;
      this.upload_in_progress = false;
      var resp;
      try {
		resp = $.parseJSON(xhr.responseText);
      } finally { }
      if (!resp ||
		  !resp.success ||
		  resp.piece_size_received != this.writer.databytes) {
		if (this.writer.attempts++ < 4) {
		  // retry this block
		  this.send_chunk_to_server();
		} else {
		  $(this.domTarget).longupload('stop');
		  this.state = 'finished';
		  this.error = resp && resp.error ? resp.error : null;
		  this.onfailure();
		  this.next();
		}
      }
      else {
		delete this.writer.blob;
		var elapsed = ((new Date()).getTime() - this.uploadStartTime) / 1000;
		if (this.writer.databytes > 0 ||
			this.writer.start > this.uploadStartByte) {
		  var MBps = (this.writer.start + this.writer.databytes - this.uploadStartByte)/elapsed/1000000;
		  this.current_speed = [MBps.toFixed(MBps<2?3:1), ' MB/s'].join('');
		}
		else
		  this.current_speed = false;
		this.current_pos = this.writer.start + this.writer.databytes;
		this.onprogress();
		if (this.reader.ready) {
		  this.reader.ready = false;
		  this.filereader_onload();
		}
      }
    }
  }
  Job.prototype.filereader_onerror = function() {
    if (!this.read_in_progress) return;
    this.error = 'while reading: '+this.filereader.error.code;
    this.onfailure();
    this.next();
  }
  Job.prototype.filereader_onload = function() {
    if (!this.read_in_progress)
      return;
    if ('boolean' == typeof this.read_in_progress) {
      this.read_in_progress = false;
      this.state = 'finished';
      this.onsuccess();
      this.next();
      return;
    }
    if (this.filereader.result.length != this.reader.databytes) {
      // The user agent lied; the read operation failed.  Do what the
      // user agent should have done.
      this.filereader = $.extend ({}, this.filereader, { 'error': { 'code': 'no error, but '+this.filereader.result.length+' of '+this.reader.databytes+' bytes read' } });
      return this.filereader_onerror();
    }
    if (this.upload_in_progress) {
      this.reader.ready = true;
      return;
    }
    var qs = quicksig(this.filereader.result,
					  this.ludata.opts.bQuicksigSize);
    var elapsed = ((new Date()).getTime()-this.reader.startTime)/1000;
    this.lastblocktime = elapsed - this.elapsed;
    this.elapsed = elapsed;
    if (this.state == 'scan') {
      this.file_quicksig += "," + [this.reader.start,
								   this.reader.blob.size,
								   qs].join("-");
      var MBps = (this.reader.start + this.reader.blob.size)/elapsed/1000000;
      this.current_speed = [MBps.toFixed(1), ' MB/s'].join('');
      this.current_pos = Math.min(this.file.size, this.reader.start + this.bufsize);
      this.onprogress();
    }
    else {
	  this.writer = { "start": this.reader.start,
					  "databytes": this.reader.blob.size,
					  "quicksig": qs,
					  "blob": this.reader.blob,
					  "attempts": 1 };
	  this.send_chunk_to_server();
    }
    this.reader.start += this.bufsize;
    if (this.state == "scan" &&
		this.reader.start >= this.file.size) {
      this.state = "server-sync";
      this.onprogress();
      this.reader.startTime = (new Date()).getTime();
      var thisjob = this;
      this.xhr = $.post(this.ludata.opts.sUploadHandlerURI,
						{ "file_quicksig": this.file_quicksig },
						function(d,t,r){
						  thisjob.read_in_progress = false;
						  thisjob.handle_server_response_to_upload_start(d);
						},
						"json");
      return;
    }
    else if (this.state == "upload" &&
			 this.server_says.max_databytes &&
			 this.bufsize < 128*1024*1024 &&
			 this.lastblocktime < 2) {
      this.bufsize = Math.min (this.bufsize * 2, this.server_says.max_databytes);
    }
    this.read_current_slice();
  }
  function stop() {
    return this.each(function(){
		var ludata = $(this).data('longupload');
		$.each(ludata.jobs, Job.prototype.abort);
		if (ludata.jobs.length > 0)
		  ludata.jobs[0].queueTarget.queue('longupload', []);
		ludata.jobs.splice(0);
      });
  }
  function go(opts) {
    if (typeof opts !== 'object')
      opts = {};
    this.longupload("stop");
    this.each(clear_progressbars);
	var queue = [];
    var queueTarget = $(opts.sQueueTarget ? opts.sQueueTarget : document);
    var alljobs = [];
    var ret = this.each(function(){
		var $this = $(this);
		var ludata = $this.data("longupload");
		for (var i=0; this.files[i]; i++) {
		  var f = this.files[i];
		  var job = new Job ({"ludata": ludata,
							  "domTarget": this,
							  "queueTarget": queueTarget,
							  "file": f,
							  "state": "scan",
							  "file_quicksig": ""+f.size,
							  "bufsize": ludata.opts.fScanChunkSize(f.size),
							  "reader": { "ready": 0,
										  "start": 0,
										  "startTime": (new Date()).getTime() },
							  'filereader': new FileReader() });
		  ludata.jobs.push(job);
		  alljobs.push(job);
		  if (ludata.opts.bAutoProgressBar)
			add_progressbar(this, $this, job);
		  var runjob = function(next) {
			arguments.callee.job.next = next;
			arguments.callee.job.read_current_slice();
		  };
		  runjob.job = job;
		  queue.push(runjob);
		  $this.trigger($.Event('longupload-queue'), [job]);
		}
      });
    var runfinish = function(){
      queueTarget.trigger($.Event('longupload-queue-finish'), [alljobs]);
    };
    runfinish.trigger_finish = true;
	queue.push(runfinish);
	queueTarget.queue('longupload', queue);
    queueTarget.dequeue('longupload');
    return ret;
  }
  function clear_progressbars() {
    $($(this).data('longupload').opts.sProgressTarget).empty();
  }
  function add_progressbar(input, $input, job) {
    var target = $($input.data('longupload').opts.sProgressTarget);
    if (!target)
      return;
    var row = $('<div><div></div><br /><div></div><div></div></div>');
    row.children('div').css('display','inline-block');
    var textdiv = row.children('div:eq(0)');
    var scandiv = row.children('div:eq(1)');
    var uploaddiv = row.children('div:eq(2)');
    scandiv.css('margin','0 5px 0 0');
	scandiv.css({'height': '12px', 'width': '100px'});
	uploaddiv.css({'height': '12px', 'width': '400px'});
    scandiv.progressbar().children('div');
    uploaddiv.progressbar().children('div');
    textdiv.css('font', '9pt sans-serif');
    target.append(row);
    job.progressbar_row = row;
    function progressfunction (e, j, p) {
	  if (j != job) return;
      var statustext;
      var speed = p && p.speed ? '(' + p.speed + ')' : '';
	  var d = new Date();
	  var datestring = d.toString().
		replace(/ GMT[-+][0-9]+( \([A-Z]+\))?/, '').
		replace(/ [0-9][0-9][0-9][0-9] /, ' ');
      if (e.type == 'longupload-queue') {
		statustext = 'queued';
      }
      else if (e.type == 'longupload-success') {
		scandiv.progressbar('option', 'value', 100);
		uploaddiv.progressbar('option', 'value', 100);
		statustext = '<b>finished</b> ' + speed + ' ' + datestring;
      }
      else if (e.type == 'longupload-failure') {
		var error = p.error ? '(' + p.error + ')' : '';
		statustext = '<b>failed</b> ' + error + ' ' + datestring;
      }
      else if (e.type == 'longupload-abort') {
		statustext = '<b>cancelled</b> at ' + datestring;
      }
      else if (p.state == 'server-sync') {
		scandiv.progressbar('option', 'value', 100);
		statustext = '100% scanned, waiting for server';
      }
      else {
		var pdiv = p.state == 'scan' ? scandiv : uploaddiv;
		var percent = 100 * p.position / p.size;
		pdiv.progressbar('option', 'value', percent);
		statustext = [(p.state == 'scan' ? 'scanned ' : 'uploaded '),
					  percent.toFixed(0), '% [',
					  humanBytes(p.position), '] ',
					  speed].join('');
      }
      textdiv.html(['<span style="font:9pt monospace">',
					job.file.name, '</span> [',
					humanBytes(job.file.size), '] ', statustext].join(''));
    }
    $input.bind('longupload-queue', progressfunction);
    $input.bind('longupload-progress', progressfunction);
    $input.bind('longupload-success', progressfunction);
    $input.bind('longupload-failure', progressfunction);
    $input.bind('longupload-abort', progressfunction);
  }
})(jQuery);
