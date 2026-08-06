pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
function seed_audio()
 poke(0x3100,0x80,0xc0,0x40,0x40)
 for i=0,31 do
  poke(0x3200+i*2,24+i%12,14)
 end
 poke(0x3241,8)
 poke(0x3242,0)
 poke(0x3243,16)
end

function _init()
 poke(0x5f2d,7)
 for i=0,15 do poke(0x5000+i,0) end
 seed_audio()
 music(0,nil,1)
 sfx(0,1,0,8)
end

function _update60()
 poke(0x5000,peek(0x5000)+1)
 if btn(0,0) then poke(0x5001,peek(0x5001)+1) end
 if btn(4,1) then poke(0x5002,peek(0x5002)+1) end
 if stat(30) then
  local c=stat(31)
  if c=="q" then poke(0x5003,peek(0x5003)+1) end
 end
 poke(0x5004,flr(stat(32)))
 poke(0x5005,flr(stat(33)))
 if stat(36)!=0 then poke(0x5006,peek(0x5006)+1) end
 if stat(38)!=0 or stat(39)!=0 then poke(0x5007,peek(0x5007)+1) end
 if btn(4,0) then poke(0x5008,peek(0x5008)+1) end
end

function _draw()
 cls(1)
 for i=0,8 do pset(peek(0x5000+i)%128,i,7) end
end
