//! Déclarations C minimales pour les frameworks Apple (CoreFoundation, CoreMedia,
//! VideoToolbox, CoreGraphics, ApplicationServices). Aucune dépendance Objective-C.
#![allow(non_upper_case_globals, non_snake_case, dead_code)]

use std::ffi::c_void;

pub type CFTypeRef = *const c_void;
pub type CFStringRef = *const c_void;
pub type CFDictionaryRef = *const c_void;
pub type CFArrayRef = *const c_void;
pub type CFAllocatorRef = *const c_void;
pub type CFBooleanRef = *const c_void;
pub type CFNumberRef = *const c_void;
pub type CFIndex = isize;
pub type OSStatus = i32;

pub type CMSampleBufferRef = *mut c_void;
pub type CMFormatDescriptionRef = *const c_void;
pub type CMBlockBufferRef = *mut c_void;
pub type CVPixelBufferRef = *mut c_void;
pub type VTCompressionSessionRef = *mut c_void;

pub type CGEventRef = *mut c_void;
pub type CGEventSourceRef = *mut c_void;
pub type CGDirectDisplayID = u32;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CMTime {
    pub value: i64,
    pub timescale: i32,
    pub flags: u32,
    pub epoch: i64,
}
impl CMTime {
    pub fn new(value: i64, timescale: i32) -> Self {
        Self { value, timescale, flags: 1, epoch: 0 }
    }
    pub fn invalid() -> Self {
        Self::default()
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGSize {
    pub width: f64,
    pub height: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CGRect {
    pub origin: CGPoint,
    pub size: CGSize,
}

#[repr(C)]
pub struct CFDictionaryKeyCallBacks {
    _p: [u8; 0],
}
#[repr(C)]
pub struct CFDictionaryValueCallBacks {
    _p: [u8; 0],
}

pub type VTCompressionOutputCallback = extern "C" fn(
    output_ref_con: *mut c_void,
    source_frame_ref_con: *mut c_void,
    status: OSStatus,
    info_flags: u32,
    sample_buffer: CMSampleBufferRef,
);

pub const kCFNumberSInt32Type: CFIndex = 3;
pub const kCFNumberFloat64Type: CFIndex = 6;
pub const kCMVideoCodecType_H264: u32 = u32::from_be_bytes(*b"avc1");

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub static kCFBooleanTrue: CFBooleanRef;
    pub static kCFBooleanFalse: CFBooleanRef;
    pub static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
    pub static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
    pub fn CFRelease(cf: CFTypeRef);
    pub fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    pub fn CFNumberCreate(alloc: CFAllocatorRef, the_type: CFIndex, value_ptr: *const c_void) -> CFNumberRef;
    pub fn CFDictionaryCreate(
        alloc: CFAllocatorRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        num_values: CFIndex,
        key_callbacks: *const CFDictionaryKeyCallBacks,
        value_callbacks: *const CFDictionaryValueCallBacks,
    ) -> CFDictionaryRef;
    pub fn CFDictionaryContainsKey(dict: CFDictionaryRef, key: CFTypeRef) -> u8;
    pub fn CFArrayGetCount(arr: CFArrayRef) -> CFIndex;
    pub fn CFArrayGetValueAtIndex(arr: CFArrayRef, idx: CFIndex) -> CFTypeRef;
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    pub static kCMSampleAttachmentKey_NotSync: CFStringRef;
    pub fn CMSampleBufferGetSampleAttachmentsArray(sb: CMSampleBufferRef, create: u8) -> CFArrayRef;
    pub fn CMSampleBufferGetFormatDescription(sb: CMSampleBufferRef) -> CMFormatDescriptionRef;
    pub fn CMSampleBufferGetDataBuffer(sb: CMSampleBufferRef) -> CMBlockBufferRef;
    pub fn CMBlockBufferGetDataLength(bb: CMBlockBufferRef) -> usize;
    pub fn CMBlockBufferCopyDataBytes(bb: CMBlockBufferRef, offset: usize, len: usize, dest: *mut c_void) -> OSStatus;
    pub fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        fd: CMFormatDescriptionRef,
        index: usize,
        ptr_out: *mut *const u8,
        size_out: *mut usize,
        count_out: *mut usize,
        nal_header_len_out: *mut i32,
    ) -> OSStatus;
}

#[link(name = "VideoToolbox", kind = "framework")]
extern "C" {
    pub static kVTCompressionPropertyKey_RealTime: CFStringRef;
    pub static kVTCompressionPropertyKey_ProfileLevel: CFStringRef;
    pub static kVTCompressionPropertyKey_AllowFrameReordering: CFStringRef;
    pub static kVTCompressionPropertyKey_AverageBitRate: CFStringRef;
    pub static kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: CFStringRef;
    pub static kVTCompressionPropertyKey_ExpectedFrameRate: CFStringRef;
    pub static kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel: CFStringRef;
    pub static kVTVideoEncoderSpecification_EnableLowLatencyRateControl: CFStringRef;
    pub static kVTEncodeFrameOptionKey_ForceKeyFrame: CFStringRef;

    pub fn VTCompressionSessionCreate(
        allocator: CFAllocatorRef,
        width: i32,
        height: i32,
        codec_type: u32,
        encoder_specification: CFDictionaryRef,
        source_image_buffer_attributes: CFDictionaryRef,
        compressed_data_allocator: CFAllocatorRef,
        output_callback: VTCompressionOutputCallback,
        output_callback_ref_con: *mut c_void,
        session_out: *mut VTCompressionSessionRef,
    ) -> OSStatus;
    pub fn VTSessionSetProperty(session: VTCompressionSessionRef, key: CFStringRef, value: CFTypeRef) -> OSStatus;
    pub fn VTCompressionSessionPrepareToEncodeFrames(session: VTCompressionSessionRef) -> OSStatus;
    pub fn VTCompressionSessionEncodeFrame(
        session: VTCompressionSessionRef,
        image_buffer: CVPixelBufferRef,
        pts: CMTime,
        duration: CMTime,
        frame_properties: CFDictionaryRef,
        source_frame_ref_con: *mut c_void,
        info_flags_out: *mut u32,
    ) -> OSStatus;
    pub fn VTCompressionSessionCompleteFrames(session: VTCompressionSessionRef, until: CMTime) -> OSStatus;
    pub fn VTCompressionSessionInvalidate(session: VTCompressionSessionRef);
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub fn CGMainDisplayID() -> CGDirectDisplayID;
    pub fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
    pub fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
    pub fn CGEventCreateMouseEvent(src: CGEventSourceRef, kind: u32, pos: CGPoint, button: u32) -> CGEventRef;
    pub fn CGEventCreateKeyboardEvent(src: CGEventSourceRef, keycode: u16, down: bool) -> CGEventRef;
    pub fn CGEventCreateScrollWheelEvent2(src: CGEventSourceRef, units: u32, count: u32, w1: i32, w2: i32, w3: i32) -> CGEventRef;
    pub fn CGEventSetFlags(event: CGEventRef, flags: u64);
    pub fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
    pub fn CGEventKeyboardSetUnicodeString(event: CGEventRef, len: usize, chars: *const u16);
    pub fn CGEventPost(tap: u32, event: CGEventRef);
    pub fn CGPreflightScreenCaptureAccess() -> bool;
    pub fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub static kAXTrustedCheckOptionPrompt: CFStringRef;
    pub fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

/// Construit un CFDictionary {clé: valeur} (les valeurs sont retenues par le dictionnaire).
pub unsafe fn cf_dict(pairs: &[(CFTypeRef, CFTypeRef)]) -> CFDictionaryRef {
    let keys: Vec<CFTypeRef> = pairs.iter().map(|p| p.0).collect();
    let vals: Vec<CFTypeRef> = pairs.iter().map(|p| p.1).collect();
    CFDictionaryCreate(
        std::ptr::null(),
        keys.as_ptr(),
        vals.as_ptr(),
        pairs.len() as CFIndex,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks,
    )
}

pub unsafe fn cf_i32(v: i32) -> CFNumberRef {
    CFNumberCreate(std::ptr::null(), kCFNumberSInt32Type, &v as *const i32 as *const c_void)
}

pub unsafe fn cf_f64(v: f64) -> CFNumberRef {
    CFNumberCreate(std::ptr::null(), kCFNumberFloat64Type, &v as *const f64 as *const c_void)
}
