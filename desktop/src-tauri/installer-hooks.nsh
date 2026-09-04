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
  ; 🔴 **升级不是卸载。** 升级时安装器会带 /UPDATE 去跑老卸载器（installer.nsi 里
  ; `StrCpy $R1 "$R1 /UPDATE"` 那一句），Section Uninstall 照样执行到这里。不挡住的话，
  ; 每升一次级就把五家的登记全收回来一次，然后新版本装上、记录没了、reconcile 无事可做 ——
  ; 用户升个级，所有 agent 就都不连了。Tauri 自己删用户数据那两处也是这么挡的。
  ${If} $UpdateMode = 1
    DetailPrint "升级中，连接器保持原样。"
    Goto done
  ${EndIf}

  ; 设置和模型是**用户的东西**，默认留着——但问这一句的不是我们：Tauri 自带的卸载确认页
  ; 已经有一个「同时删除应用数据」的勾选框（un.ConfirmShow 建的，默认不勾，状态存在
  ; $DeleteAppDataCheckboxState 里），用户在那一页已经回答过了。这里直接读那个变量，
  ; 不再自己弹一个 MessageBox 问同一件事——问两遍，两次答案还可能对不上。
  ${If} $DeleteAppDataCheckboxState = 1
    DetailPrint "正在移除连接器，并清除设置与模型…"
    nsExec::ExecToLog '"$INSTDIR\agent-avatar.exe" --uninstall --purge'
  ${Else}
    DetailPrint "正在从各个 agent 里移除连接器…"
    nsExec::ExecToLog '"$INSTDIR\agent-avatar.exe" --uninstall'
  ${EndIf}
  Pop $0

  done:
  ; 失败不阻断卸载：用户要的是把这个 app 弄走，而收不回来的那几家，
  ; 设置里那个「移除所有连接器」按钮仍然能补一次。
!macroend
