#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface WorkbenchDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate>
@property (strong) NSWindow *window;
@property (strong) WKWebView *web;
@property (strong) NSTextField *status;
@property (strong) NSTask *child;
@property (strong) NSPipe *pipe;
@property (strong) NSMutableData *buffer;
@property (strong) NSURL *url;
@end

@implementation WorkbenchDelegate

- (BOOL)supportsRuntime:(NSString *)candidate {
    if (![[NSFileManager defaultManager] isExecutableFileAtPath:candidate]) return NO;
    NSTask *probe = [[NSTask alloc] init];
    NSPipe *output = [NSPipe pipe];
    probe.executableURL = [NSURL fileURLWithPath:candidate];
    probe.arguments = @[@"--version"];
    probe.standardInput = [NSFileHandle fileHandleWithNullDevice];
    probe.standardOutput = output;
    probe.standardError = [NSFileHandle fileHandleWithNullDevice];
    NSError *error = nil;
    if (![probe launchAndReturnError:&error]) return NO;
    NSData *bytes = [output.fileHandleForReading readDataToEndOfFile];
    [probe waitUntilExit];
    if (probe.terminationStatus != 0) return NO;
    NSString *version = [[[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding]
                         stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if ([version hasPrefix:@"v"]) version = [version substringFromIndex:1];
    NSArray<NSString *> *parts = [version componentsSeparatedByString:@"."];
    if (parts.count < 2) return NO;
    NSInteger major = parts[0].integerValue, minor = parts[1].integerValue;
    return (major == 22 && minor >= 19) || (major >= 23 && major <= 26);
}

- (NSString *)nodePath {
    NSMutableArray<NSString *> *choices = [NSMutableArray array];
    const char *custom = getenv("SANDBOX_MCP_NODE");
    if (custom != NULL && strlen(custom) > 0) {
        NSString *configured = [NSString stringWithUTF8String:custom];
        return [self supportsRuntime:configured] ? configured : nil;
    }
    NSString *path = [[[NSProcessInfo processInfo] environment] objectForKey:@"PATH"];
    for (NSString *folder in [path componentsSeparatedByString:@":"]) {
        if (folder.length) [choices addObject:[folder stringByAppendingPathComponent:@"node"]];
    }
    [choices addObjectsFromArray:@[@"/opt/homebrew/bin/node", @"/usr/local/bin/node", @"/usr/bin/node"]];
    NSString *versionsRoot = [NSHomeDirectory() stringByAppendingPathComponent:@".nvm/versions/node"];
    NSArray<NSString *> *versions = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:versionsRoot error:NULL];
    versions = [versions sortedArrayUsingComparator:^NSComparisonResult(NSString *left, NSString *right) {
        return [right compare:left options:NSNumericSearch];
    }];
    for (NSString *version in versions) {
        [choices addObject:[[versionsRoot stringByAppendingPathComponent:version] stringByAppendingPathComponent:@"bin/node"]];
    }
    for (NSString *candidate in choices) {
        if ([self supportsRuntime:candidate]) return candidate;
    }
    return nil;
}

- (void)setMessage:(NSString *)message {
    self.status.stringValue = message;
}
- (void)makeWindow {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,760,540)
                                             styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                        NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                                               backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"Sandbox Monitor";
    self.window.minSize = NSMakeSize(620,460);
    NSView *root = self.window.contentView;
    root.wantsLayer = YES;
    self.web = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,760,495)];
    self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.web.navigationDelegate = self;
    [root addSubview:self.web];

    NSView *bar = [[NSView alloc] initWithFrame:NSMakeRect(0,495,760,45)];
    bar.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    NSTextField *title = [NSTextField labelWithString:@"Sandbox Monitor"];
    title.font = [NSFont boldSystemFontOfSize:14];
    title.frame = NSMakeRect(16,13,180,18);
    [bar addSubview:title];
    self.status = [NSTextField labelWithString:@"准备启动…"];
    self.status.font = [NSFont systemFontOfSize:11];
    self.status.textColor = [NSColor secondaryLabelColor];
    self.status.frame = NSMakeRect(198,13,330,18);
    [bar addSubview:self.status];
    NSButton *reload = [NSButton buttonWithTitle:@"刷新" target:self action:@selector(reload:)];
    reload.frame = NSMakeRect(680,8,64,28);
    reload.autoresizingMask = NSViewMinXMargin;
    [bar addSubview:reload];
    [root addSubview:bar];

    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self makeWindow];
    NSURL *repo = [[NSBundle mainBundle].bundleURL URLByDeletingLastPathComponent];
    NSURL *script = [repo URLByAppendingPathComponent:@"runtime/desktop-commander/local-workbench-server.mjs"];
    if (![[NSFileManager defaultManager] isReadableFileAtPath:script.path]) {
        [self setMessage:@"找不到监测服务；请勿将 App 移出项目目录。"];
        return;
    }
    NSString *node = [self nodePath];
    if (!node) { [self setMessage:@"没有找到 Node.js 22.19–26；请设置 SANDBOX_MCP_NODE。"]; return; }
    self.child = [[NSTask alloc] init];
    self.child.executableURL = [NSURL fileURLWithPath:node];
    self.child.arguments = @[script.path];
    self.child.currentDirectoryURL = repo;
    self.pipe = [NSPipe pipe];
    self.buffer = [NSMutableData data];
    self.child.standardOutput = self.pipe;
    self.child.standardError = [NSFileHandle fileHandleWithNullDevice];
    self.child.standardInput = [NSFileHandle fileHandleWithNullDevice];

    __weak typeof(self) weakSelf = self;
    self.pipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *bytes = [handle availableData];
        if (bytes.length == 0) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf receiveBytes:bytes];
        });
    };
    self.child.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (task.terminationStatus != 0) [weakSelf setMessage:@"监测服务已退出；请关闭后重新打开 App。"];
        });
    };
    NSError *error = nil;
    if (![self.child launchAndReturnError:&error]) {
        [self setMessage:[NSString stringWithFormat:@"服务启动失败：%@",error.localizedDescription]];
    } else {
        [self setMessage:@"正在连接本地监测服务…"];
    }
}

- (void)receiveBytes:(NSData *)bytes {
    [self.buffer appendData:bytes];
    const char *ptr = (const char *)self.buffer.bytes;
    NSUInteger length = self.buffer.length;
    NSUInteger cursor = 0;
    for (NSUInteger i = 0; i < length; i++) {
        if (ptr[i] == '\n') {
            NSData *line = [NSData dataWithBytes:ptr+cursor length:i-cursor];
            NSString *message = [[NSString alloc] initWithData:line encoding:NSUTF8StringEncoding];
            NSString *prefix = @"SANDBOX_WORKBENCH_URL ";
            if ([message hasPrefix:prefix]) {
                NSString *address = [message substringFromIndex:prefix.length];
                NSURL *target = [NSURL URLWithString:address];
                if ([target.scheme isEqualToString:@"http"] && [target.host isEqualToString:@"127.0.0.1"] && target.port) {
                    self.url = target;
                    [self.web loadRequest:[NSURLRequest requestWithURL:target]];
                    [self setMessage:@"监测台已连接 · Chat 仍在网页中操作"];
                }
            }
            cursor = i+1;
        }
    }
    if (cursor != 0) [self.buffer replaceBytesInRange:NSMakeRange(0,cursor) withBytes:NULL length:0];
}
- (void)reload:(id)sender {
    if (self.url) [self.web loadRequest:[NSURLRequest requestWithURL:self.url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:30]];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action
                                                  decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
    NSURL *target = action.request.URL;
    if ([target.host isEqualToString:@"127.0.0.1"] && [target.port isEqual:self.url.port]) {
        handler(WKNavigationActionPolicyAllow);
    } else {
        handler(WKNavigationActionPolicyCancel);
        if ([target.scheme isEqualToString:@"https"]) [[NSWorkspace sharedWorkspace] openURL:target];
    }
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    self.pipe.fileHandleForReading.readabilityHandler = nil;
    if (self.child.isRunning) [self.child terminate];
    return NSTerminateNow;
}
@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        WorkbenchDelegate *delegate = [[WorkbenchDelegate alloc] init];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
