import Cocoa
import CoreGraphics
import ApplicationServices
for argument in CommandLine.arguments.dropFirst() {
 if let pid=Int32(argument) {
  let app=NSRunningApplication(processIdentifier:pid);app?.unhide()
  let element=AXUIElementCreateApplication(pid);var value:CFTypeRef?
  AXUIElementCopyAttributeValue(element,kAXWindowsAttribute as CFString,&value)
  for window in value as? [AXUIElement] ?? [] {
   AXUIElementSetAttributeValue(window,kAXMinimizedAttribute as CFString,kCFBooleanFalse)
   AXUIElementPerformAction(window,kAXRaiseAction as CFString)
  }
  app?.activate(options:[.activateAllWindows])
 }
}
let windows = CGWindowListCopyWindowInfo(.optionAll,kCGNullWindowID) as? [[String:Any]] ?? []
var result:[[String:Any]]=[]
for w in windows {
 let owner=w[kCGWindowOwnerName as String] as? String ?? ""
 if !owner.lowercased().contains("linklab") {continue}
 let pid=w[kCGWindowOwnerPID as String] as? Int32 ?? 0
 let app=NSRunningApplication(processIdentifier:pid)
 var row:[String:Any]=["pid":pid,"owner":owner,"onScreen":w[kCGWindowIsOnscreen as String] as? Bool ?? false,"layer":w[kCGWindowLayer as String] as? Int ?? -1,"hidden":app?.isHidden ?? false,"bounds":w[kCGWindowBounds as String] ?? [:]]
 let element=AXUIElementCreateApplication(pid);var value:CFTypeRef?
 let error=AXUIElementCopyAttributeValue(element,kAXWindowsAttribute as CFString,&value)
 if error == .success, let axWindows=value as? [AXUIElement] {
  row["axWindows"]=axWindows.map { window -> [String:Any] in
   var minimized:CFTypeRef?;var title:CFTypeRef?
   AXUIElementCopyAttributeValue(window,kAXMinimizedAttribute as CFString,&minimized)
   AXUIElementCopyAttributeValue(window,kAXTitleAttribute as CFString,&title)
   return ["minimized":minimized as? Bool ?? false,"title":title as? String ?? ""]
  }
 }
 result.append(row)
}
let data=try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]);print(String(data:data,encoding:.utf8)!)
