; NSIS 安装器/卸载器的钩子（`bundle.windows.nsis.installerHooks` 指到这里）。
;
; 🔴 **删掉这个 app 不会带走它装进别人应用里的东西。** 五家 harness 的配置里仍然登记着
; agent-avatar，而那些 hook 命令行指向一个马上就要被删掉的解释器 —— `plugin list` 里还挂着
; 它，每次开会话都会去启动一个不存在的程序。那是留在别人应用里的垃圾，而用户没有理由知道
; 要去哪清。
;
; 所以卸载前先让 app 自己把登记收回来。用的是它自己的代码（同一条 `uninstall_from` 路径），
; 而不是在这里去猜五家的配置格式在哪、长什么样 —— 那正是我们花了两天才学会不要做的事。

!macro NSIS_HOOK_PREUNINSTALL
  ; 设置和模型是**用户的东西**，默认留着。问一句，默认「否」—— 卸载器顺手带走用户内容
  ; 是一种很容易被原谅、但不该犯的错。
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "同时删除你的设置和已导入的模型吗？$\r$\n$\r$\n选「否」的话它们会留在 %APPDATA% 下，重装后仍在。" \
    /SD IDNO IDYES purge_data IDNO keep_data

  purge_data:
    DetailPrint "正在移除连接器，并清除设置与模型…"
    nsExec::ExecToLog '"$INSTDIR\agent-avatar.exe" --uninstall --purge'
    Pop $0
    Goto done

  keep_data:
    DetailPrint "正在从各个 agent 里移除连接器…"
    nsExec::ExecToLog '"$INSTDIR\agent-avatar.exe" --uninstall'
    Pop $0

  done:
  ; 失败不阻断卸载：用户要的是把这个 app 弄走，而收不回来的那几家，
  ; 设置里那个「移除所有连接器」按钮仍然能补一次。
!macroend
