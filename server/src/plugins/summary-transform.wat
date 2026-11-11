;; Returns a summary with a different shape from the upstream tool's items.
(component
  (core module $module
    (memory (export "memory") 1)
    (global $next (mut i32) (i32.const 1024))
    (func (export "realloc") (param i32 i32 i32 i32) (result i32)
      (local $ptr i32)
      (local.set $ptr
        (i32.and
          (i32.add (global.get $next) (i32.sub (local.get 2) (i32.const 1)))
          (i32.sub (i32.const 0) (local.get 2))))
      (global.set $next (i32.add (local.get $ptr) (local.get 3)))
      (local.get $ptr))
    (data (i32.const 128) "{\22summary\22:\22Three items\22}")
    (func (export "transform") (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
      (i32.store (i32.const 68) (i32.const 128))
      (i32.store (i32.const 72) (i32.const 25))
      (i32.const 64)))
  (core instance $core (instantiate $module))
  (type $input (record
    (field "action-id" string)
    (field "upstream-name" string)
    (field "arguments-json" string)
    (field "result-json" string)
    (field "attachments" (list string))))
  (type $output (record
    (field "structured-json" string)
    (field "attachments" (list u32))))
  (type $result (result $output (error string)))
  (type $signature (func (param "input" $input) (result $result)))
  (func $transform (type $signature)
    (canon lift (core func $core "transform")
      (memory (core memory $core "memory")) (realloc (core func $core "realloc"))))
  (instance $interface
    (export "transform-input" (type $input))
    (export "transform-output" (type $output))
    (export "transform" (func $transform)))
  (export "squire:mcp-transform/transform" (instance $interface)))
