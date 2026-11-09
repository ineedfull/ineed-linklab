// Diagnostic dylib for an explicitly launched, isolated Tauri development host.
// This file is never linked into or loaded by a production installation.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#import <mach-o/dyld.h>

static void collect(NSView *view, NSMutableArray *result) {
    if ([view isKindOfClass:WKWebView.class]) [result addObject:view];
    for (NSView *child in view.subviews) collect(child, result);
}
static void reply(NSString *directory, id identifier, id value, NSError *error) {
    NSDictionary *result = error ? @{ @"id":identifier, @"error":error.description }
                                : @{ @"id":identifier, @"value":value ?: NSNull.null };
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    [data writeToFile:[directory stringByAppendingPathComponent:@"response.json"] atomically:YES];
}
static void handle(NSString *directory, NSDictionary *request) {
    NSMutableArray *views = [NSMutableArray array];
    for (NSWindow *window in NSApp.windows) collect(window.contentView, views);
    WKWebView *target = nil, *frontend = nil;
    NSMutableArray *info = [NSMutableArray array];
    for (WKWebView *view in views) {
        NSString *url = view.URL.absoluteString ?: @"", *type = NSStringFromClass(view.class);
        [info addObject:@{ @"url":url, @"class":type }];
        if ([type containsString:@"Inspector"] || [url containsString:@"inspector"]) frontend = view;
        else if ([url hasPrefix:@"http://127.0.0.1:"]) target = view;
    }
    NSString *operation = request[@"op"]; id identifier = request[@"id"];
    if ([operation isEqualToString:@"open"] || [operation isEqualToString:@"close"]) {
        if (!target) { reply(directory, identifier, @{ @"error":@"missing target", @"views":info }, nil); return; }
        id inspector = ((id (*)(id, SEL))objc_msgSend)(target, NSSelectorFromString(@"_inspector"));
        if ([operation isEqualToString:@"close"]) {
            ((void (*)(id, SEL))objc_msgSend)(inspector, NSSelectorFromString(@"close"));
        } else {
            ((void (*)(id, SEL))objc_msgSend)(inspector, NSSelectorFromString(@"show"));
            ((void (*)(id, SEL))objc_msgSend)(inspector, NSSelectorFromString(@"detach"));
        }
        reply(directory, identifier, @{ @"views":info }, nil); return;
    }
    if ([operation isEqualToString:@"eval"] && frontend) {
        [frontend evaluateJavaScript:request[@"script"] completionHandler:^(id value, NSError *error) {
            reply(directory, identifier, value, error);
        }]; return;
    }
    reply(directory, identifier, @{ @"error":@"missing inspector frontend", @"views":info }, nil);
}
__attribute__((constructor)) static void startProbe(void) {
    const char *directory = getenv("LINKLAB_MEMORY_PROBE_DIR");
    if (!directory) return;
    char executable[4096]; uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) || !strstr(executable, "Ineed LinkLab.app/Contents/MacOS/")) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *folder = [NSString stringWithUTF8String:directory];
        __block id last = nil;
        [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
            NSData *data = [NSData dataWithContentsOfFile:[folder stringByAppendingPathComponent:@"request.json"]];
            NSDictionary *request = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
            if (request[@"id"] && ![last isEqual:request[@"id"]]) { last = request[@"id"]; handle(folder, request); }
        }];
    });
}
