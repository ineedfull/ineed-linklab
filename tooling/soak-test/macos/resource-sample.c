#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libproc.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <unistd.h>
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t);
/* Test-only macOS sampler. Filter by the owned host's responsibility ID in
 * the caller; process names alone also match unrelated WebKit applications. */
int main(void) {
 int count=proc_listallpids(NULL,0); pid_t *pids=calloc(count+1024,sizeof(pid_t));
 count=proc_listallpids(pids,(count+1024)*sizeof(pid_t));
 printf("["); int emitted=0;
 for(int i=0;i<count;i++) {
  char name[4096]={0}; if(proc_pidpath(pids[i],name,sizeof(name))<=0)continue;
  if(!strstr(name,"LinkLab")&&!strstr(name,"com.apple.WebKit"))continue;
  struct rusage_info_v4 usage={0}; if(proc_pid_rusage(pids[i],RUSAGE_INFO_V4,(rusage_info_t *)&usage)!=0)continue;
  if(emitted++)printf(",");
  printf("{\"pid\":%d,\"responsible\":%d,\"rss\":%llu,\"footprint\":%llu,\"userTime\":%llu,\"systemTime\":%llu,\"name\":\"%s\"}",pids[i],responsibility_get_pid_responsible_for_pid(pids[i]),usage.ri_resident_size,usage.ri_phys_footprint,usage.ri_user_time,usage.ri_system_time,name);
 }
 puts("]"); free(pids); return 0;
}
