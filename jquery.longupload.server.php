<? ;

// Copyright 2011 Clinical Future, Inc.

require_once 'class.jQueryLonguploadReceiver.php';
$receiver = new jQueryLonguploadReceiver;
if($receiver->handle_post()) exit;
