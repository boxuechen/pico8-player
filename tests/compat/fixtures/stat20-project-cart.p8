pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
tick=0
ok=true
function _init()
 for i=0,15 do
  poke(0x3200+i*2,24+i)
  poke(0x3201+i*2,0x0e)
 end
 poke(0x3241,4)
 local idle=stat(20)
 sfx(0,0,0,16)
 local active=stat(20)
 ok=type(idle)=="number" and idle==-1 and type(active)=="number" and active==0
end
function _update()
 tick+=1
 local note=stat(20)
 if type(note)!="number" then error("stat20 type") end
 if tick==1 and note!=1 then error("stat20 note1 "..note) end
 if tick==2 and note!=2 then error("stat20 note2 "..note) end
 if tick==3 then
  if note!=3 then error("stat20 note3 "..note) end
  sfx(-1,0)
  if stat(20)!=-1 then error("stat20 stop") end
 end
end
function _draw()
 cls(ok and 3 or 8)
 print("stat20 ok",43,61,7)
end
