// Read-only OpenVR background observer. Never submits frames or changes settings.
#include <openvr.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <cerrno>
#include <dlfcn.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
static volatile sig_atomic_t running=1;
static void stop(int){running=0;}
static double now(){timespec t{};clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
int main(int argc,char **argv){
 const bool history=argc==5&&!std::strcmp(argv[4],"--history");
 if((argc!=4&&!history)||getuid()!=1000||!getenv("VR_PATHREG_OVERRIDE"))return 2;
 char comm_path[128];std::snprintf(comm_path,sizeof(comm_path),"/proc/%u/comm",unsigned(std::strtoul(argv[2],nullptr,10)));
 struct stat st{};if(stat(comm_path,&st)||st.st_uid!=1000)return 3;
 FILE *f=std::fopen(comm_path,"r");char comm[64]{};if(!f)return 3;
 bool existing=std::fgets(comm,sizeof(comm),f)&&!std::strcmp(comm,"vrcompositor\n");std::fclose(f);if(!existing)return 3;
 // A runtime must already exist; background init is never a boot mechanism.
 if(access(argv[3],R_OK))return 3;
 if(mkdir("/tmp/mix-openvr-observer",0700)&&errno!=EEXIST)return 8;
 struct stat logdir{};if(lstat("/tmp/mix-openvr-observer",&logdir)||!S_ISDIR(logdir.st_mode)||logdir.st_uid!=1000)return 8;
 void *lib=dlopen("/opt/steamvr/bin/linuxarm64/libopenvr_api.so",RTLD_NOW|RTLD_LOCAL);if(!lib)return 4;
 auto init=reinterpret_cast<uint32_t(*)(vr::EVRInitError*,vr::EVRApplicationType,const char*)>(dlsym(lib,"VR_InitInternal2"));
 auto get=reinterpret_cast<void*(*)(const char*,vr::EVRInitError*)>(dlsym(lib,"VR_GetGenericInterface"));
 auto shutdown=reinterpret_cast<void(*)()>(dlsym(lib,"VR_ShutdownInternal"));
 if(!init||!get||!shutdown)return 5;
 vr::EVRInitError error=vr::VRInitError_None;
 if(!init(&error,vr::VRApplication_Background,nullptr)||error!=vr::VRInitError_None)return 6;
 auto *compositor=static_cast<vr::IVRCompositor*>(get(vr::IVRCompositor_Version,&error));
 if(!compositor||error!=vr::VRInitError_None){shutdown();return 7;}
 auto *system=history?static_cast<vr::IVRSystem*>(get(vr::IVRSystem_Version,&error)):nullptr;
 signal(SIGTERM,stop);signal(SIGINT,stop);setvbuf(stdout,nullptr,_IOLBF,0);
 double end=now()+std::strtod(argv[1],nullptr);
 double last_frame_seconds=-1; uint32_t last_index=0; unsigned epoch=0;
 while(running&&now()<end){
  if(history){
   // Runtime vsync is an observation, not an optical scanout measurement.
   // Preserve the query bracket: neither runtime seconds nor frame counters
   // are silently identified with CLOCK_MONOTONIC / kernel vblank sequence.
   if(system){
    float elapsed=0;uint64_t counter=0;
    double vb_before=now();bool valid=system->GetTimeSinceLastVsync(&elapsed,&counter);double vb_after=now();
    std::printf("MIX_VSYNC {\"mono_before_seconds\":%.9f,\"mono_after_seconds\":%.9f,\"valid\":%s,\"seconds_since_vsync\":%.9f,\"counter\":%llu,\"physical_scanout_verified\":false}\n",vb_before,vb_after,valid?"true":"false",double(elapsed),(unsigned long long)counter);
   }
   vr::Compositor_FrameTiming batch[128]{};batch[0].m_nSize=sizeof(batch[0]);
   double before=now();uint32_t count=compositor->GetFrameTimings(batch,128);double after=now();
   if(count>128)count=128;
   if(count&&last_frame_seconds>batch[count-1].m_flSystemTimeInSeconds){last_frame_seconds=-1;last_index=0;++epoch;}
   vr::Compositor_CumulativeStats stats{};compositor->GetCumulativeStats(&stats,sizeof(stats));
   // Keep the newest entry pending: a subsequent frame may complete its GPU timing.
   // The final pending entry is deliberately not fabricated on observer shutdown.
   for(uint32_t i=0;i+1<count;++i){
    const auto &f=batch[i];
    if(f.m_flSystemTimeInSeconds<=last_frame_seconds)continue;
    uint32_t advance=f.m_nFrameIndex-last_index;
    uint32_t missing=last_frame_seconds>=0&&advance>0&&advance<0x80000000u?advance-1:0;
    std::printf("MIX_FRAME_TIMING {\"schema\":1,\"epoch\":%u,\"poll_mono_before_seconds\":%.9f,\"poll_mono_after_seconds\":%.9f,\"runtime_frame_seconds\":%.9f,\"clock_mapping_verified\":false,\"frame_index\":%u,\"missing_indices_before\":%u,\"stats_pid\":%u,\"presents\":%u,\"mispresents\":%u,\"dropped\":%u,\"reprojection_flags\":%u,\"pre_submit_gpu_ms\":%.6f,\"post_submit_gpu_ms\":%.6f,\"total_render_gpu_ms\":%.6f,\"compositor_gpu_ms\":%.6f,\"compositor_cpu_ms\":%.6f,\"compositor_idle_ms\":%.6f,\"client_interval_ms\":%.6f,\"present_call_ms\":%.6f,\"wait_present_ms\":%.6f,\"submit_ms\":%.6f,\"wait_get_poses_ms\":%.6f,\"new_poses_ready_ms\":%.6f,\"new_frame_ready_ms\":%.6f,\"compositor_update_start_ms\":%.6f,\"compositor_update_end_ms\":%.6f,\"compositor_render_start_ms\":%.6f,\"vsyncs_ready\":%u,\"vsyncs_to_first_view\":%u,\"transfer_latency_ms\":%.6f,\"hmd_pose_valid\":%s,\"tracking_result\":%d}\n",
     epoch,before,after,f.m_flSystemTimeInSeconds,f.m_nFrameIndex,missing,stats.m_nPid,
     f.m_nNumFramePresents,f.m_nNumMisPresented,f.m_nNumDroppedFrames,f.m_nReprojectionFlags,
     f.m_flPreSubmitGpuMs,f.m_flPostSubmitGpuMs,f.m_flTotalRenderGpuMs,f.m_flCompositorRenderGpuMs,
     f.m_flCompositorRenderCpuMs,f.m_flCompositorIdleCpuMs,f.m_flClientFrameIntervalMs,
     f.m_flPresentCallCpuMs,f.m_flWaitForPresentCpuMs,f.m_flSubmitFrameMs,
     f.m_flWaitGetPosesCalledMs,f.m_flNewPosesReadyMs,f.m_flNewFrameReadyMs,
     f.m_flCompositorUpdateStartMs,f.m_flCompositorUpdateEndMs,f.m_flCompositorRenderStartMs,
     f.m_nNumVSyncsReadyForUse,f.m_nNumVSyncsToFirstView,f.m_flTransferLatencyMs,
     f.m_HmdPose.bPoseIsValid?"true":"false",int(f.m_HmdPose.eTrackingResult));
    const auto &p=f.m_HmdPose;
    std::printf("MIX_FRAME_POSE {\"epoch\":%u,\"frame_index\":%u,\"runtime_frame_seconds\":%.9f,\"scope\":\"runtime reported application render pose; not late warp pose\",\"valid\":%s,\"connected\":%s,\"tracking_result\":%d,\"matrix34\":[",
     epoch,f.m_nFrameIndex,f.m_flSystemTimeInSeconds,p.bPoseIsValid?"true":"false",p.bDeviceIsConnected?"true":"false",int(p.eTrackingResult));
    for(unsigned row=0;row<3;++row)for(unsigned col=0;col<4;++col)
     std::printf("%s%.9g",row||col?",":"",double(p.mDeviceToAbsoluteTracking.m[row][col]));
    std::printf("],\"world_linear_velocity\":[%.9g,%.9g,%.9g],\"angular_velocity\":[%.9g,%.9g,%.9g]}\n",
     double(p.vVelocity.v[0]),double(p.vVelocity.v[1]),double(p.vVelocity.v[2]),
     double(p.vAngularVelocity.v[0]),double(p.vAngularVelocity.v[1]),double(p.vAngularVelocity.v[2]));
    last_frame_seconds=f.m_flSystemTimeInSeconds;last_index=f.m_nFrameIndex;
   }
   if(!count)std::printf("MIX_FRAME_TIMING_STATUS {\"available\":false,\"poll_mono_seconds\":%.9f}\n",after);
   usleep(100000);continue;
  }
  vr::Compositor_FrameTiming f{};f.m_nSize=sizeof(f);
  bool ok=compositor->GetFrameTiming(&f);
  vr::Compositor_CumulativeStats s{};compositor->GetCumulativeStats(&s,sizeof(s));
  std::printf("MIX_TIMING {\"monotonic_seconds\":%.9f,\"frame_valid\":%s,\"frame_index\":%u,\"frame_seconds\":%.9f,\"stats_pid\":%u,\"presents\":%u,\"submits\":%u,\"dropped\":%u,\"reprojected\":%u,\"compositor_gpu_ms\":%.6f,\"compositor_cpu_ms\":%.6f,\"total_render_gpu_ms\":%.6f,\"client_interval_ms\":%.6f,\"present_call_ms\":%.6f,\"wait_present_ms\":%.6f}\n",
   now(),ok?"true":"false",f.m_nFrameIndex,f.m_flSystemTimeInSeconds,s.m_nPid,s.m_nNumFramePresents,s.m_nNumFrameSubmits,s.m_nNumDroppedFrames,s.m_nNumReprojectedFrames,f.m_flCompositorRenderGpuMs,f.m_flCompositorRenderCpuMs,f.m_flTotalRenderGpuMs,f.m_flClientFrameIntervalMs,f.m_flPresentCallCpuMs,f.m_flWaitForPresentCpuMs);
  usleep(500000);
 }
 shutdown();dlclose(lib);return 0;
}
